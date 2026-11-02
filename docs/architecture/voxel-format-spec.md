# Voxel world formats — spec v1

Status: **DRAFT v1 — awaiting owner approval (hard stop). Nothing builds on it as final until approved.**

Phase 45 drafted this spec ([plan](../plan-phase-45.md) §3). It describes the code on branch `phase-45`
(`packages/voxel/src`, `@thirdlight/voxel`) as it stands, byte for byte where something is a byte format. The
numbers come from the plan's results subsections (45.1 to 45.9). Anything the plan calls unverified is unverified
here too. Where this file and the code disagree, the code is what runs, and the disagreement is listed in §7.
The requirement list lives in [voxel-format-requirements.md](voxel-format-requirements.md); R-, O- and Q-ids
refer to it.

---

## 1. Summary for the owner

### What is stored

The world is a grid of 0.5 m voxels. Each voxel stores four things:

- a **material** (a number; 0 means air);
- a coarse **category**: air, terrain, construction, roof or liquid;
- a **shape**: how full the cell is, from 0 to 255;
- an **orientation** byte.

Beams, banisters, posts and the other architectural details are **not stored**. They are worked out from how the
voxels sit next to each other, every time the world is rebuilt (§3.7). Water is ordinary voxels with the liquid
category.

- **Chunks.** Voxels are grouped into cubes of 32 × 32 × 32 (16 m), called chunks.
- **Only surfaces store a shape.** A chunk stores one shape byte for each *surface* voxel: a partly full cell, or
  the top cell of a lake. Full ground and empty air store nothing extra.
- **Simple chunks cost almost nothing.** A chunk that is all air is not stored at all. A chunk that is one voxel
  everywhere (deep rock, a solid wall) costs 12 bytes on disk.
- **Region files.** On disk, chunks are grouped into region files. A file covers a 256 m × 256 m tile of ground and
  256 m of height ("stacked cubes", proposed below). A world grows tile by tile.
- **Saves hold only player changes.** A save keeps only the chunks the player changed, each compared against the
  shipped world. A building's hand edits are kept apart from the voxels it generates, as overrides.
- **Never stored.** Meshes, collision, the walk-graph input, light occupancy, the low-detail far-field levels
  (mips) and prop light coverage are always rebuilt and never stored.

### How big

All test worlds are synthetic, engine-owned and swept whole. The "on disk" column includes the region file
tables.

| Test world | On disk | In memory, if all loaded (dense arrays) | Notes |
|---|---|---|---|
| plain ground, 256 m | 4.3 MB/km² | 2.1 MB (210 MB) | ground 64 m deep |
| hilly, 2 × 2 km | 5.8 MB/km² | 163 MB = 41 MB/km² (18.4 GB) | 77 % of chunks uniform |
| town, 256 m (+11 rotated houses) | 1.6 MB/km² | 2.0 MB (213 MB) | walls, floors, roofs, banisters, beams |
| caves, 256 m | 56 MB/km² | 15.4 MB (283 MB) | 3D overhangs, tunnels and caverns |
| vertical, 256 m × 2 km tall | 188 MB/km² | 55 MB (3.2 GB) | a mountain, deep caverns and a 300 m tower |

- **Memory.** 0.04–0.27 bytes a voxel. The plan's target was about 4 bytes.
- **Material ids** are 23 bits (8,388,607 a world). Storing them at rest as 3 bytes instead of 2 added 0.1–1.8 %
  to the sizes above, which were measured before (45.7d).
- **A whole 10 × 10 km world** of plain to hilly ground projects to **430–580 MB** in 1,600 tiles, about 0.3 MB
  per tile. Mountains, caves and dense towns raise that. This is a projection from the 2 km world; no 10 km world
  was built.
- **Git.** A scripted hour of heavy editing (1,200 strokes) grows the packed history by 0.13–0.22 MB, because git
  stores each new file version as a small delta. **No Git LFS is needed.**

### How fast

The measurements ran on this host (i5-12600H, Iris Xe), in Node or headless Chrome. The low-tier budget is the
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
- **Unsolved (D432):** with 40 ms of added network latency the near ring empties. The proposed fix (fewer, wider
  reads and prefetching) is not built yet.

**Rebuilding derived data**
- 0.5–3.4 ms a chunk (median, Node, reference mesher).
- The shared assembly step is about 0.2 ms of that.

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

### Plan decisions that did not pan out (owner chooses)

Under the plan's rule, these are **not dropped** until the owner chooses. Each keeps its goal through a proposed
replacement, and the code already follows that proposal as a DRAFT.

1. **R18, vertical run-length per column → bit-packing plus a general compressor (zstd).**
   - *Goal kept:* plain ground costs about what a height map costs. It is 4.3 MB/km² either way.
   - *Why the change:* runs cost as much memory or more and make strokes slower (table above).
   - *Cost of the replacement:* none measured. Runs stay possible only where no compressor runs, and they lose
     there too.
   - **Owner chooses.**
2. **R50, full-height region columns → stacked 256 m cubes.**
   - *Goal kept:* no height limit, and small commits.
   - *Why the change:* on the 2 km tall world a column file is 12.3 MB, and a one-voxel save rewrites all of it.
     With stacked cubes it rewrites 1.47 MB, and files stay under 2.7 MB.
   - *Cost of the replacement:* twice the files where ground crosses a stack boundary (hilly world: 64 → 128
     files), and +0.1 % bytes.
   - Both layouts are in the format; the code uses stacked.
   - **Owner chooses.**
3. **R79, one shared occupancy bitmask for every system → one assembly evaluation, then a separate output per
   consumer.**
   - *Goal kept:* cheap, exact grid queries per chunk.
   - *Why the change:* a beam or a rail must block movement but not light or sight, and must not be stood on. One
     bitmask cannot say that.
   - *The replacement:* separate outputs for rendering, light, navigation and collision.
   - *Cost:* 0.5–4.3 KB of light, 0.8–3.7 KB of navigation and 0.6–2.6 KB of occupancy a chunk, instead of one 4 KB
     mask, plus about 0.5 ms a chunk.
   - **Owner chooses.**
4. **R66, streaming exports by HTTP range with the default read settings → batched, wider reads with prefetching
   along the motion** (D432).
   - *Goal kept:* exports stream on demand.
   - *Why the change:* 4 reads in flight with a 4 KB gap empty the near ring at 40 ms latency. A 64 KB gap fills it,
     but fetches 9× the bytes.
   - *The replacement:* not a format change; the region table already allows any range. Not built yet.
   - **Owner chooses.**

**Not failures, for completeness.** §7a revised these by direction, not because a measurement failed:
- R12 and R13 (per-cell roles, rules only in the tools) became inferred architecture;
- R11's "role" became a stored coarse category;
- R83 (an edit rebuilds only its own chunk) became a dependency radius;
- R86, R87 and R88 are kit and mesh topics for 46b/46c.

The brick ray-marched far field was moved to 46c by the owner (2026-10-28); it was not tried in 45.

### What the owner decides at this stop

**Before v1 freezes:**
- the three replacements above, and the D432 approach;
- **the stored category set (Q-a):** air, terrain, construction, roof, liquid. The 45.6 placeholder rules need
  nothing more; the role spec (46b) may want more categories;
- the defaults listed in §5, among them 45.7d's: the material id width (23 bits, §2.2) and the orientation
  numbering (24 rotations, provisional).

**Open, and not part of v1 yet:**
- dependencies across grids: the job contract's keys, aprons and invalidation are per grid (§3.6 open contract
  gap, with the planned design, before 47a);
- what each orientation means to a case (O8; the numbering is set, 46b gives the cases their meaning);
- where paint is stored (O16);
- shoreline cells that are both ground and water (O15).

**The record value has no spare bit (decide together with O15 and O16).** Material 23 + category 4 +
orientation 5 = 32 bits. If O15 (a cell holding ground plus a liquid fill) or O16 (paint per voxel) needs bits in
every voxel, the record must widen. Each form that stores raw record values outside the chunk codec (region
uniform entries, cell deltas in undo records and saves, save uniform payloads, structure overrides) therefore
names its **record value form** (§2.2): form 1 is today's u32. A wider form is added beside it, so files written
now stay readable and no format needs a new version for it. The owner picks one (default chosen, owner to
confirm: value forms now, the 23/4/5 split unchanged):
- settle O15 and O16 first, and widen the record before v1 freezes if either needs per-voxel bits;
- keep spare bits now (a 21- or 22-bit material id, still 2–4 M ids);
- or rely on the value forms and widen add-only later (what the code does).

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

### 2.2 Voxel record — category set and orientation meaning PROVISIONAL (Q-a; `record.ts`)

| Field | Width | Values | Notes |
|---|---|---|---|
| material | 23 bits (u24 at rest) | 0 = air, 1–8,388,607 (`MATERIAL_ID_MAX`) | Refers to the material record (plan §1c, 46c). A format width, not a count cap (R7, O12; default chosen, owner to confirm: see §7 G7) |
| category | u8 | 0 air, 1 terrain, 2 construction, 3 roof, 4 liquid | Stored intent (Q-a option 1). 5–255 are unassigned and refused (`VOXEL_CATEGORY_COUNT`) |
| shape | u8 | 0 empty … 255 full | Stored only on surface voxels (§3.1) |
| orientation | u8 | 0–23: one of the 24 axis-aligned rotations, 0 the identity | PROVISIONAL until the role and case catalogue (46b) gives the cases their meaning. 24–255 are refused (`ORIENTATION_COUNT`). Nothing derived reads it yet (O8) |

- **Air is one value.** Material 0 means air, and every other field is then 0. Writers clear them (the store's
  `setVoxel`, the cell delta, the commands), and the codec refuses air with any other field set.
- **Orientation numbering** (`orientationMatrix`). Orientation k is `face(k >> 2) · spin(k & 3)`: first `k & 3`
  quarter turns about the voxel's own +y (counter-clockwise seen from above: +x goes to −z), then the tip that
  carries +y to its face: 0 +y (none), 1 −y (a half turn about +x), 2 +x, 3 −x, 4 +z, 5 −z (quarter turns about z
  or x). The 24 are distinct proper rotations (tested).
- **Record value.** The packed form used in palettes, deltas, aprons and region entries is
  `material | category << 23 | orientation << 27`, a u32: material in bits 0–22, category in 23–26 (room for 16),
  orientation in 27–31 (room for 32). Shape travels beside it. Every field must fit its width; readers refuse a
  wider value before packing it. No bit is spare (§1).
- **Record value form** (`RECORD_VALUE_FORM` = 1, `checkValueForm`). Every format that stores raw record values
  outside the chunk codec records the form they are in: the region file (header byte 10, its uniform entries), the
  undo record (byte 7, its deltas), the save (byte 8, its deltas and uniform payloads) and the structure overrides
  (byte 6). Form 1 is the u32 above. A reader refuses a form newer than it knows. A later, wider form is added
  beside form 1: readers of form 1 are kept, and lifting a form-1 value is a pure widening (each field keeps its
  value). The chunk codec stores the fields in planes of their own and is versioned by its own byte. Forms that
  only cross threads inside one build (the chunk wire, aprons, job messages) are never persisted and carry no form:
  both ends run the same build.
- **Every stored value is checked** (`checkRecordValue`): region uniform entries, save uniform payloads, cell
  deltas and overrides refuse an unassigned category or orientation, and air that is not the one air value; a cell
  delta or override also refuses air with a non-zero shape. A refused region table refuses the file, so its chunks
  are reported damaged.
- **Implied shape.** Air is 0 and any other material is 255. A voxel is a **surface voxel** when its shape differs
  from its implied shape. That covers partly full ground, a liquid's partly full top cell, and any non-air cell
  with shape 0. The rule depends on the voxel's own value only, never on its neighbours.
- **Q-a minimum contract (draft).** The stored intent that the derived-data pipeline needs is category plus
  material plus shape, with category telling terrain, construction, roof and liquid apart.
  - The 45.6 placeholder rules read only the category. The consumers add material and ground density.
  - Nothing reads orientation or structure data.
  - A house written by its generator and the same voxels written as runtime `fill` commands derive to identical
    bytes (plan **45.6 derived data**).
- **What the category costs.** In a record palette it costs 0 % memory and 0.2–2.9 % of the zstd bytes. The
  orientation field costs ≤ 5 % of memory and 3.2 % of zstd bytes in the town, and ≤ 0.8 % elsewhere (45.2a).
  - *Caveat:* in the test worlds no material is used in two categories.

---

## 3. The spec, by area

### 3.1 Chunk store

**Memory form** (`palette-store.ts`, `palette-chunk.ts`, `brick-layout.ts`, `surface-density.ts`,
`chunk-index.ts`). This is not a file format; it is the measured pick, a DRAFT.

**Chunk index.** An open-addressing table keyed by (column, y): `ChunkIndex`, about 15–20 ns a lookup. A chunk in
the index is one of three things:
- **absent:** all air;
- **one record value:** the chunk is that voxel everywhere, with its implied shape. It costs 8 B;
- **a palette chunk:** a record palette, sparse bricks and the surface densities, as described below.

**Record palette.** Each palette entry is one record value, plus a flag saying whether that entry's cells carry a
density byte.
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

**Surface densities.** A sorted `Uint32Array` of `cell << 8 | density`, found by binary search.

**Reading.** `voxelAt(x, y, z)` is the one read path (R21):
- an absent chunk reads as air;
- a uniform chunk is answered from its index entry;
- otherwise one packed read, plus a density search for flagged entries.

**On the wire** (`chunk-wire.ts`). A chunk crosses threads as its own arrays, transferred, never copied:
- the palette values and metadata;
- the brick, mask, pool and free-slot arrays;
- the density words.

The payload form is `air`, `uniform` (a value) or `stored` (edge plus arrays). It has no version of its own, since
both ends run the same build; the job message is versioned instead. It is checked on adoption: a damaged payload is
refused and the store is left unchanged.

#### Chunk codec v1 — bytes at rest (`palette-codec.ts`)

Little-endian. "Planes held" is a bit mask: 1 material, 2 category, 4 shape, 8 orientation.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 2 | magic `VC` (0x56 0x43) |
| 2 | 1 | codec version = 1 (an older one is lifted through `CHUNK_CODEC_UPGRADES`, a newer one refused) |
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

**Uniform body (6 bytes; 14 bytes with the header).** u24 material, u8 category, u8 shape, u8 orientation. The
shape must equal the implied shape, so a uniform chunk never holds a surface voxel.

**Packed body, record palette:**
1. u16 entry count − 1.
2. The material of every entry (u24 each), then the category of every entry (u8 each), then the orientation of
   every entry (u8 each). Each field is its own plane, so the compressor sees runs of like values (R20).
3. The density flags as a bitset: ⌈count / 8⌉ bytes. Entry e is bit (e mod 8) of byte ⌊e / 8⌋. Bits past the
   palette must be 0.
4. The cells' entry ids in local-index order, at width w = `packedWidth(count)`:
   - w = 0: nothing;
   - w = 1, 2 or 4: 8 / w cells a byte, least significant first;
   - w = 8: u8 per cell;
   - w = 16: u16 per cell.
5. One u8 density for each cell whose entry is flagged, in cell order.

**Canonical bytes (R51).** The encoder always produces these, and the decoder refuses anything else:
- entries are numbered by first appearance in cell order;
- no entry is unused or repeated (a value together with its flag);
- no stored density equals the implied shape;
- a chunk of one entry without densities is a uniform body, never a packed one;
- air is one value: an entry or a uniform voxel of material 0 has category 0, orientation 0 and no density flag;
- category and orientation hold assigned values only (0–4, 0–23);
- no bytes follow the body;
- no padding or flag bits are set past the end.

So one chunk's content has exactly one byte string, whatever edits led to it, and every byte string the world
decoder accepts is the one its content encodes to (crafted bytes tested, `format-rules.test.ts`). The bench entry
also refuses a mixed brick holding a single id (body 3).

**Versions (R3).** `CHUNK_CODEC_UPGRADES` holds the codec's upgrade steps, keyed by the version each lifts from and
only ever added to; v1 has none (the registry is frozen and empty). A step takes a whole chunk's bytes of its version
and returns the same content's bytes of the next version, header and CRC included. Every world reader lifts older
bytes through the steps before reading them (`liftChunkBytes`), so a codec v2 keeps reading every v1 file without a
rewrite; a version with no step, or newer than this build's, is refused, and a step that does not land on the next
version is refused. The mechanism is tested with a test-only "version 0" and its step.

**General compressor.** **zstd level 3 per chunk** when a stored chunk goes into a region file (zstd 19 is proposed
for exports, which are derived). Browser workers decode it with **fzstd 0.1.1**, a pinned dev dependency that
passes the export scan.

#### Measured (45.2a/45.2b, 32³)

| World | Memory, bricks | zstd body MB/km² | voxelAt random / coherent ns | Single edit µs | Node decode µs a chunk |
|---|---|---|---|---|---|
| plain | 2.1 MB | 4.30 | 35 / 14 | 0.10 | 132 |
| hilly | 163 MB | 5.91 | 36 / 13 | 0.24 | 91 |
| town | 2.0 MB | 1.66 | 38 / 15 | 0.10 | 205 |
| caves | 15.4 MB | 55.4 | 111 / 22 | 0.14 | 436 |
| vertical | 55 MB | 187 | 67 / 17 | 0.13 | 246 |

These were measured with a u16 material plane. The u24 plane (45.7d) adds 0.1–1.8 % to the zstd bytes (plan
**45.7d format gaps**); memory, access and edit times do not change.

Every sweep compared every chunk, a 1-in-37 sample of `voxelAt` reads, every fourth decode, and 200 k edits plus
1,500 strokes against the dense oracle, at both chunk edges on every world. All were equal.

### 3.2 Region file v1 (`region-file.ts`; magic `TLVR`)

One region file holds one tile of one grid of one world: a 256 m column or a 256 m stacked cube. The file is pure
bytes; the compressor is passed in. Little-endian.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 4 | magic `TLVR` |
| 4 | 1 | region format version = 1 (an older one is lifted through `REGION_UPGRADES`, a newer one refused) |
| 5 | 1 | layout: 0 full-height column, 1 stacked cube |
| 6 | 1 | chunk edge in cells (16 or 32) |
| 7 | 1 | chunk codec version the file was written with (1 to this build's; chunks of an older version are lifted on read) |
| 8 | 1 | compressor of stored chunks: 0 none, 1 zstd |
| 9 | 1 | side: chunks along each side of the region (16 for 256 m at 32³) |
| 10 | 1 | record value form of the uniform entries (§2.2; 1) |
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
  - a uniform chunk: its record value, then 0;
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
  and only ever added to; v1 has none. A step lifts a file's header and table to the next version and says where its
  version's table ends (`indexEnd`, from the first 64 bytes); the stored chunks are not touched and keep their own
  codec version. Readers lift the index (`liftRegionIndex`) and read chunks by range from the file as it is, from
  where its table ends (`RegionIndex.dataStart`). Tested with a test-only "version 0" of 16-byte entries.
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

### 3.3 Edits: stroke command v1 (`edit-command.ts`, `edit-apply.ts`)

**One command is one stroke**, in plain JSON. It rides the existing command envelope as an op's arguments (R6, R56).

**Canonical form.** `canonicalEditCommand` rebuilds the command field by field and refuses:
- an unknown field;
- an unknown version (`v` must be 1);
- an out-of-range value;
- −0 (normalised to 0).

Common fields: `v: 1`, `grid` (u32; 0 is the world grid), `kind`.

| kind | Fields |
|---|---|
| `brush` | `shape` (sphere / box / cylinder) · `size` [x, y, z] half extents in cells (a sphere's are all filled in from x; a cylinder's x and z from x) · `points` (flat x y z dab centres in cells, at least one) · `mode` · `voxel` (absent for dig) · `smooth` |
| `fill` | `min`, `max` (integer cells, both inclusive) · `mode` · `voxel` |
| `stamp` | `stamp` {`id`, `hash` (64 hex digits)} · `origin` [x, y, z] · `yaw` [cos, sin] (cos² + sin² = 1 within 1e−9) · `scale` > 0 · `mode` · `voxel` · `smooth` |
| `set` | `cells` (flat integer x y z; canonical order below) · `voxel` {material, category, orientation, shape} (material 0 means air, all other fields 0) |
| `dig` | `cells` (canonical order below) |

- **Cell lists.** `canonicalEditCommand` sorts a `set` or `dig` cell list by x, then z, then y (the order chunk keys
  and cells inside a chunk use) and keeps each cell once, so the same cells give one payload whatever order or
  repeats they were sent with (tested).

- **Modes.**
  - `place`: write the voxel whatever was there.
  - `add`: write only into air or liquid; a smooth add also grows the shape of a cell of the same material.
  - `dig`: remove; a smooth dig lowers the shape, and an empty cell becomes air.
  - `paint`: change material, category and orientation of non-air cells and keep their shape.
- **Smooth.** Only `add` and `dig` may be smooth.
- **Edit voxel.** Material 1–8,388,607; category 0–4; orientation 0–23 (§2.2).
- **Coverage.**
  - A brush cell is covered by the depth of its centre inside the dab shape, plus half a cell, clamped to 0–1.
    With several dabs, the largest coverage wins.
  - A hard stroke takes a cell at coverage ≥ 0.5.
  - A smooth stroke writes shape = `max(1, round(cov · 255))` at the rim.
  - A stamp samples its shape's nearest cell under the cell centre, mapped back through scale and yaw.
- **Determinism.** A cell's new voxel depends only on its old voxel and the command. The arithmetic uses only +, −,
  ×, ÷, √, floor and round, which IEEE-754 defines exactly. Tested in Node across the store and the dense oracle;
  another JavaScript engine is unverified.
- **All or nothing.** These refusals happen before the first write: `grid_unknown`, `chunk_not_loaded`,
  `stamp_unknown`, `stamp_changed`, `outside_world`, `over_budget`.
- **Work bound (`over_budget`).** One command's worst-case undo record must fit the undo budget (§3.4): the chunks
  it can touch × the worst case of one chunk (`chunkWorstUndoBytes`: 15 + cells × 7 bytes, 229,391 B at 32³)
  ≤ `UNDO_MEMORY_BUDGET_BYTES`, so at most 292 chunks of 32³ (2,339 of 16³) at 64 MiB. The chunks are counted from
  the command alone before any cell is visited: a box's chunks for a fill or stamp, listed cells' chunks for set
  and dig, and for a brush the union of its dabs' chunks (a long thin drag counts the chunks it reaches, not its
  bounding box). A world-sized fill or a 2 km sphere is refused at once; the memory and time of one command are
  bounded with it. A budget, not a count: the same bytes fit more chunks of a smaller edge.
- **No change.** A command that changes nothing reports 0 cells; the command layer refuses it as `no_change`.
- **Answers.** The backend answers an applied command with the changed chunks and its cell box (`box`: the cells
  the command can change, from `editBounds`). An undo answers the box of the edit it takes back. A client derives
  again only the results within the rules' radius of that box (Q-c).
- **Stamp shape.** A stamp is a box of 0.5 m cells with one coverage byte each, indexed `(x · sz + z) · sy + y`.
  Its hash is the SHA-256 (hex) of the three sizes (u16 LE each) followed by the coverage bytes.
- **Size bound.** A long drag must fit the command pipeline's 64 KB request bound, about 2,000 dabs. Thinning the
  dabs to a spacing is the tool's job (proposal for 47b).

### 3.4 Undo record v1 (`undo-store.ts`; magic `TLVU`) and budget

An undo record holds, for every chunk the command changed, what that chunk was before. It holds whichever of two
forms is smaller:
- a **cell delta**: the changed cells' old voxels, at 7 bytes a cell;
- the chunk's whole **before-image**: its canonical codec bytes. An absent chunk costs 0 bytes and a uniform one 14.

An image is encoded only once the delta outgrows the smallest image, which is 4 KB at 32³.

- **Redo** re-applies the command. It is deterministic and works last-in, first-out.
- **The undo step is a new revision** (the command model's inverse), never a rewind.

**Cell delta bytes** (`cell-delta.ts`): n × u16 local cells (ascending), then n × u32 record values (0 for air;
value form 1), then n × u8 shapes (0 for air). Writing all cells, then all values, then all shapes lets the
compressor find runs. The reader refuses a value the format does not hold and air with a shape.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 4 | magic `TLVU` |
| 4 | 1 | version = 1 |
| 5 | 1 | chunk edge |
| 6 | 1 | chunk codec version |
| 7 | 1 | record value form of its deltas (§2.2; 1) |
| 8 | 4 | chunk count |
| 12 | … | per chunk: u32 grid, i16 cx, i16 cy, i16 cz, u8 kind (0 delta, 1 image, 2 absent), u32 length, payload |
| end − 4 | 4 | CRC-32 of everything before it |

- **Budget.** `UNDO_MEMORY_BUDGET_BYTES` = 64 MiB **per open world** (the backend keeps one undo store for each
  world it has open, so a process with several open worlds holds up to 64 MiB for each), a memory budget with no
  step count (R7). Beyond it, the oldest records spill to an `UndoSpill`: files in the backend, IndexedDB in a
  browser. The IndexedDB spill is not built yet. One command's worst-case record must fit it too (§3.3, work bound).
- **Ordering.** Calls run in order, so a put during a spill write cannot spill a record twice.

**Measured (45.4):** 22 B for one voxel, 95–103 B for a 1 m dab, 1.5–1.6 KB for a 4 m dab, 45–60 KB for a 16 m
fill. 64 MiB holds about 43 k 4 m dabs, or 1.1–1.5 k 16 m fills.

### 3.5 Save file v1 (`save-file.ts`; magic `TLVS`) and structure overrides v1 (`structure-overrides.ts`; magic `TLVO`)

**Save:**
- **Edits only (R59).** A save holds only the chunks that differ from the shipped world. A chunk changed and then
  changed back has no entry.
- **The player's cells, always.** Every entry records which cells the player changed: a cell delta lists them; a
  whole-chunk entry (the chunk as it is now: an image, one voxel, or all air) carries a **changed-cell mask** beside
  it. The writer keeps whichever payload is smaller (the delta on a tie); the choice never changes what loading
  does.
- **Base hash (R60).** Each entry carries a **base hash**: the first 16 bytes of the SHA-256 of the shipped chunk's
  content in the **base form**. An all-air base hashes as no bytes.
- **The base form is frozen: the chunk codec version 1 canonical bytes of the content** (§3.1, header included),
  whatever codec version the chunk is stored in (`BASE_FORM_CODEC_VERSION` = 1). Bytes already of version 1 are
  hashed as they are (the world decoder accepts only canonical bytes, so they are the one byte string of their
  content); bytes of any other version are decoded and written in the base form first (`baseContentHash`). A later
  codec keeps a version 1 writer for this. So neither recompressing a world nor a codec upgrade looks like a changed
  world. If a later record holds content version 1 cannot write (a wider value form, §2.2), the base form gains an
  extension then; such content was never the base of an older save, so no older hash can match it wrongly. Tested
  with a frozen hash of a fixed chunk, the same content through a test-only older codec version, and through a
  test-only newer layout read back to its content.

**Header (44 bytes):**

| Offset | Bytes | Field |
|---|---|---|
| 0 | 4 | magic `TLVS` |
| 4 | 1 | save version = 1 |
| 5 | 1 | chunk edge |
| 6 | 1 | chunk codec version (1 to this build's; older images are lifted when decoded) |
| 7 | 1 | compressor: 0 none, 1 zstd (the whole body is one stream) |
| 8 | 1 | record value form of its deltas and uniform payloads (§2.2; 1) |
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
  - uniform: a u32 record value, never 0;
  - air: nothing.

The bytes are canonical: equal saves give equal bytes.

**Save rules:**
- **World (R5).** A save belongs to one world: `readSave` and `applySave` take the world's id and refuse a save made
  for another before anything is written.
- **Versions (R3).** A version newer than this build is refused. An older version is lifted through `SAVE_UPGRADES`:
  append-only steps on the decoded save. v1 has no steps; the mechanism is tested with a test step.
- **Base mismatch (R60).** When the base hash differs from the shipped chunk's, the mismatch is reported, and the
  game chooses per chunk:
  - `save`: the player's cells land on the new base, cell by cell (a delta's cells, or the masked cells of a
    whole-chunk entry); every cell the player did not change is the new base's. Tested: a player digs a 16-cell
    cube (a whole-chunk entry), the re-export moves a wall into that chunk through the hole's edge; with `save` the
    wall stands where the player did not dig, the hole stays, every other cell is the new base.
  - `base`: the entry is dropped.

  On a matching base a whole-chunk entry is written whole (the same result). The worker job's `apply-save` can also
  `report` without applying anything.

**Measured (45.4, then 45.8a):** after 1,000 mixed strokes, saves are 497 KB (hilly), 303 KB (town) and
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
| 4 | 1 | version = 1 |
| 5 | 1 | chunk edge |
| 6 | 1 | record value form of its values (§2.2; 1) |
| 7 | 1 | reserved, 0 |
| 8 | 4 | grid id |
| 12 | 4 | chunk count |
| 16 | … | per chunk, in key order: i16 cx, i16 cy, i16 cz, u32 n, then n × u16 cells (ascending), n × u32 base values, n × u8 base shapes, n × u32 values, n × u8 shapes (12 B a cell) |
| end − 4 | 4 | CRC-32 |

**Fit rule after regenerating (R33, R34).** For each override, compare it with what the generator now makes:
- **absorbed:** the generator now makes the override's voxel itself. The override is dropped.
- **kept:** the newly generated voxel is the same kind as the override's base (both air, or both solid with the same
  category). The override is written, and its base becomes the newly generated voxel.
- **misfit:** anything else. It is reported and not written.

This was tested on a test room grown from 6 to 8 m, not on a generator. A rule for every structure kind is 47a's.

**Overrides versions.** Overrides live as long as the project, so they upgrade like saves: a newer version is
refused, and `OVERRIDE_UPGRADES` holds append-only steps on decoded overrides (empty and frozen at v1; tested with a
test-only step). The reader refuses values the format does not hold and air with a shape.

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
| `edit` | a canonical command, copies of every chunk it can touch, its stamps (hash recomputed in the worker) → the changed chunks, cell count, the undo record (`TLVU` bytes) |
| `derive` | the chunk payload, radius R, an apron R deep, optional assembly rules {id, version, radius} → derived data (§3.7), or the exposure placeholder when no rules are named |

**Lanes.** `edit` before `near` before `far`; within a lane by distance², then by arrival. The queue is an indexed
heap with back-pressure: `maxQueued`, `room()`, and `queue_full` when full.

**Staleness (R67).** Ids and input stamps come from the `DirtyTracker`, from one counter that never repeats.
- A chunk's input stamp moves when it is edited, (re)loaded, or `invalidated` (a neighbour within R changed).
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

Each strip is either one record value (its neighbour is absent or uniform), or its cells as u32 values plus u8
shapes, in x, z, y order.
- **R is a parameter of every job,** 0 ≤ R ≤ 32. It is never a constant.
- `dependentChunks(box, R)` names every chunk within R of an edit: 8 at a corner, 27 for a box over a chunk.
- Measured at R = 2: 13 KB median, 57 KB p95 a job, against 69 KB for a dense apron.

**Residency (R64, R7).**
- **The ring** (`DEFAULT_STREAM_RING`, in cells):
  - load 384 horizontally and 192 above and below (192 m / 96 m);
  - unload past 448 / 256 (224 m / 128 m), which gives hysteresis;
  - the near lane within 192 (96 m).
- **One byte budget per tier** (`VOXEL_STREAM_BUDGET_BYTES`): low 256 MiB, medium 512 MiB, high 1 GiB. It counts:
  - the store's arrays;
  - 96 B of bookkeeping per resident chunk, air included;
  - every derived part registered per chunk;
  - the open region tables.
- **Over budget:** clean chunks are evicted farthest first (ties: least recently wanted) down to 95 % of the
  budget. Loading stops short of the nearest evicted distance until the total is below 85 %.
- **Main thread:** apron building is capped at 2 ms an update.
- **Workers keep no world state.**
  - Settings: pool size, queue bound and timeouts. The bench used 4 workers, 256 queued, a 5 s timeout, and a hung
    worker replaced after 4 × the timeout.
  - Proposed engine default for the pool size: `min(4, hardwareConcurrency − 2)`, at least 1.

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
  frame by the grids' transform (occupancy and category only, not the full record);
- **invalidation:** an edit's cell box, moved into every other grid's frame (its world-space box, rounded out),
  marks that grid's results within R of it stale (`dependentChunks` per grid);
- **staleness:** a result accepted only while the stamps of every chunk it read, in every grid, still match.
Cost to measure in 47a: the resampling per job and the extra strips' bytes.

**Measured:**
- **Node, 45.5a:** 87–173 stored chunks/s decoded; worker jobs 0.66 ms median.
- **Chrome, 45.5b:** frame p95 16.67 ms at 40 and 80 m/s on both renderers; `update()` p95 2.3–2.4 ms; ring 9–10 MB.
- **The miss:** D432, at +40 ms latency.

### 3.7 Derived data v1 — never committed, never saved (`assembly.ts`, `derived-data.ts`, `derived-mesh.ts`, `derive-assembly.ts`, `voxel-mips.ts`, `prop-coverage.ts`)

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
- **Placeholder rules v1** (`placeholder`, version 1, R = 2) read only the category: beam, rail, post, and
  everything else built is a wall. The case catalogue is 46b's; corners, stairs, openings, soffits and mouldings
  are not covered.
- **Radius conformance (every rule set).** A rule set's `radius` is its own claim, and a rule reading further would
  read past the job's apron (air, or another row's cells) with no error. `ruleRadiusMismatches(store, rules,
  chunks)` evaluates each chunk with the job's pad (R + 1) and with 3 cells more and lists every cell the
  consumers read that differs. A test runs it for every registered rule set (`registeredAssemblyRules`) on random
  worlds at both chunk edges; 46b's catalogue passes it once registered. A rule reading 2 cells while declaring 1
  is caught (tested).

**Consumer tables.** One evaluation feeds every consumer:

| Class | Render solid | Collision | Nav blocks / stands on | Light coverage |
|---|---|---|---|---|
| wall (construction, roof) | yes | full box | yes / yes | 255 |
| ground (terrain) | density ≥ 128 | the ground surface (trimesh) | density ≥ 128 | its density |
| beam | no (detail piece) | bar, 10/16 cell square | yes / no | 128 (placeholder) |
| rail / post | no (detail piece) | slab or bar, 4/16 cell thick | yes / no | 51 (placeholder) |
| liquid | no | none (49) | no / no | 0 |

**Outputs per chunk.** A result records `v` (derived format version 1), its rules {id, version, radius} and its
edge.
- **materials:** a u32 table, slot → material id, with slots in first-use order. Meshes, instances and boxes share
  it.
- **occupancy (R82):**
  - a chunk flag: 0 empty, 1 solid, 2 mixed;
  - 2 bits per 4³ brick, four bricks a byte, low bits first, bricks ordered (bx · n + bz) · n + by;
  - a bit a cell (local index) only when the chunk is mixed.
- **light:** one coverage byte when the chunk is uniform. Otherwise:
  - a bit for every fully covering cell;
  - the partial cells as u16 cells plus u8 coverages, in cell order.
- **collision (R105):**
  - boxes as 6 × u16 (min x, y, z, max x, y, z) in 1/16 cell steps from the chunk corner, with a u16 material slot
    each;
  - full-cell merges first (`fullBoxes` of them), then the partial shapes;
  - the ground surface buffer is the trimesh.
- **nav (R100):**
  - a blocking flag (empty / solid / mixed), and a bit a cell when mixed;
  - the standable cells (free, on a supporting cell) as u16 cells, plus a u8 clearance each: free cells upward up to
    4 (2 m), with bit 0x80 meaning the free run continues into the chunk above.
- **surface buffers:** two per chunk, the projected ground and the modular base. The base surface is not emitted
  under a detail piece that replaces it.
- **detail instances:** see below.

**Surface vertex** (stride 20 bytes, or 24 when the chunk's material table has more than 256 slots):

| Offset | Format | Field |
|---|---|---|
| 0 | `uint16x4` | position in 1/1024 cell from one cell below the chunk corner; w = 0 |
| 8 | `snorm8x4` | normal; w = 0 |
| 12 | `uint8x4` (or `uint16x4`) | four material slots |
| 16 (or 20) | `unorm8x4` | weights, summing to 255 |

- Indices are u16 below 65,536 vertices, otherwise u32.
- Triangles are counter-clockwise seen from outside.
- **No cracks between chunks.** A boundary vertex is a function of its 8 samples, quantised as integer steps in world
  cells, so both chunks compute the same bits. A sample edge belongs to the chunk of its lower sample, so no
  triangle is drawn twice.
- The producers are references only: naive surface nets for the ground, and one quad per exposed face for the base.
  46b replaces them, writing the same layout or bumping the version.

**Detail instance (8 bytes):**
- u8 x, y, z: the cell inside the chunk;
- u8: bits 0–1 quarter turns about +y, bits 4–7 flags (0x10 `replacesBase`);
- u16 piece: family << 2 | section. Families: beam 1, rail 2, post 3. Sections: single 0, start 1, body 2, end 3;
- u16 material slot.

**Dependency and invalidation (Q-c).**
- A job's apron is R + 1 deep: 3 for the placeholder.
- A worker refuses a job naming a rule set, version or radius it does not have.
- The streamer derives with one rule set; a rules upgrade means a new streamer that rebuilds everything, never mixed
  results.
- Tested:
  - a corner edit rebuilds exactly the 8 chunks around it;
  - an edit 3 cells under a chunk boundary changes the chunk above;
  - 16 random edits leave every result in a 32-chunk window equal to a fresh derive.

**Voxel mips (R84, R85).**
- A level-L node has the chunk's form: 32³ cells of 0.5 m × 2^L, using the same store, codec and mesher input.
- Its density is the rounded mean of its 8 children.
- Its material is the one with the largest summed density (ties: the lower id). It becomes air when the mean rounds
  to 0.
- Category and orientation come from the first cell of that material.
- `MipStaleSet` marks the ancestors of every changed chunk; they are rebuilt lowest first.
- Paint colour waits for paint storage (O16).

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
| Chunk codec | `VC` | 1 | a newer one refused | `CHUNK_CODEC_UPGRADES`, add-only, keyed by the version lifted from (v1 has none) |
| Region file | `TLVR` | 1 (+ codec version byte) | a newer one refused | `REGION_UPGRADES` (header and table; chunks by the codec's steps), add-only (v1 has none) |
| World manifest | `world.json` `format` | 2 | a newer one refused | step 1 → 2 lists the region files found (§3.2) |
| Edit command | `v` | 1 | refused | none yet |
| Undo record | `TLVU` | 1 | refused | not needed (session data) |
| Save | `TLVS` | 1 | a newer one refused | `SAVE_UPGRADES`, append-only (v1 has none) |
| Structure overrides | `TLVO` | 1 | a newer one refused | `OVERRIDE_UPGRADES`, append-only (v1 has none) |
| Record value form | byte in `TLVR`, `TLVU`, `TLVS`, `TLVO` | 1 | a newer one refused | a wider form added beside form 1 (§2.2) |
| Job message | `v` | 1 | refused | not needed (same build both ends) |
| Derived data | `DERIVED_FORMAT_VERSION` + rules ref | 1 | refused | rebuilt, never upgraded |

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
| R1 | §1 replacements, §5, §7 | decision log, "for the owner" entries (45.2a, 45.2b, 45.3, 45.5b, 45.6) | served; owner chooses |
| R2 | status line | — | waiting for the owner |
| R3 | §3.1, §3.2, §3.8 | `format-rules.test.ts` (codec and region steps, newer refused), `region.test.ts`, `edits.test.ts` (save upgrade step) | served (45.7d: codec, region and manifest steps) |
| R4 | §3.2 damage and manifest, §3.4 | 45.3, 45.4, 45.7d; `region.test.ts`, `edits.test.ts` (repair, carry-over), `voxel-world.test.ts` (a listed region gone is damaged) | served |
| R5 | §3.1 header, §3.2 world id / grid id, §3.5 save world | 45.2a, 45.3, 45.7d; `format-rules.test.ts`, `edits.test.ts` | served (45.7d: every reader checks the tile it expects) |
| R6 | §3.3 one apply | 45.4; `edits.test.ts` | served at format level; command op wiring in 46a/47c |
| R7 | §3.4, §3.6 budgets, §2.2 material width | 45.4, 45.5a, 45.7d | served (material ids 23 bits, a format width; owner to confirm) |
| R8 | — (the format has no generator) | test worlds are bench-only | served |
| R9 | §2.1 | `coords.test.ts` | served |
| R10 | all | — | later: 48 retires the old systems |
| R11 | §2.2 | 45.1, 45.2a (plane costs) | partly: provisional record; Q-a for the owner |
| R12, R13 | §3.7 (classes are derived, not stored) | 45.6; `derived.test.ts` | superseded (§7a) |
| R14 | §2.2 category + orientation | — | later: slope cases in 46b (placeholder rules read no orientation) |
| R15–R17 | §3.1 | 45.2a, 45.2b; `palette-store.test.ts`, `brick-layout.test.ts` | served |
| R18 | §1 replacement 1 | 45.2a, 45.2b | replaced (owner chooses) |
| R19 | §2.2, §3.1 | 45.2a | served |
| R20 | §3.1 planes, zstd 3 | 45.2a, 45.2b codecs | served (record palette, planes at rest) |
| R21 | §3.1 `voxelAt` | 45.1, 45.2a; `harness.test.ts` (dense oracle) | served |
| R22 | §2.1 (32³) | 45.2b | served |
| R23 | — | — | superseded by R15–R20 |
| R24, R25 | §2.2 liquid category + surface density | 45.1 worlds (lakes, ponds, cave water) | served |
| R26 | — | — | later: shoreline O15 in 49 |
| R27, R28 | §2.2 material (23 bits) | 45.7d (**45.7d format gaps**) | partly: id width set (owner to confirm); the material model is 46c's |
| R29 | §3.3 stamp | 45.4; `edits.test.ts` | served (voxelizing at import is 47b) |
| R30–R32 | §2.1 grid ids | — | later: 47a structure records |
| R33, R34 | §3.5 TLVO, fit rule | 45.4; `edits.test.ts` | served; the regenerate-all step is 47a |
| R35 | §3.5 (overrides not in region files) | 45.4 | served |
| R36–R39 | §2.1, §3.2 grid id, own folder | 45.3; `region.test.ts` | partly: streaming per grid untested (46a); transform 47a |
| R40 | §3.7 per grid | — | later: 46a/46d |
| R41, R42 | — | — | later: 49 (sea level is world metadata) |
| R43 | §3.3 commands | — | later: 47a |
| R44 | §3.7 prop channel only | 45.6 | served |
| R45 | — | — | later: openings in 46b/47a, portals in 46d |
| R46–R48 | §3.2 | 45.3 | served |
| R49 | §2.1 bounds | 45.1 vertical world, 45.3 | served |
| R50 | §1 replacement 2 | 45.3 | replaced (owner chooses) |
| R51 | §3.1, §3.2 canonical bytes, §3.3 cell lists | 45.3, 45.7d; `region.test.ts` (equal bytes by edit order), `format-rules.test.ts` (crafted bytes refused) | served (caveat: zstd build, §3.2) |
| R52 | §3.2 ranges | 45.3; `region.test.ts` (HTTP range) | served |
| R53 | §1 git | 45.3 repo growth | served (no LFS) |
| R54 | §3.7 | 45.6 | served |
| R55 | §1 sizes | 45.3 projection | served (projection; no 10 km world built) |
| R56, R57 | §3.3, §3.4 | 45.4 | served; room op 47a, copy/paste 47c |
| R58 | §3.3, §3.6, §3.7 | 45.4–45.6; slice 45.7a (§6) | partly: physics, nav graph and light in 46a/46d |
| R59, R60 | §3.5 TLVS | 45.4; `edits.test.ts`, `stream.test.ts` (apply on load, mismatch) | served |
| R61 | — | — | later: 49 (O18) |
| R62, R63 | §2.1, §3.6 floating origin | 45.5a; `stream-core.test.ts` (precision) | served |
| R64 | §3.6 budget | 45.5a, 45.5b | served for voxels + derived; colliders, light, textures in 46 |
| R65 | — | — | later: 47c |
| R66 | §3.6 export delivery | 45.5b | partly: D432, browser cache not built (46a) |
| R67–R69 | §3.6 | 45.5a, 45.5b; `stream-core.test.ts`, `stream.test.ts` | served |
| R70 | package rule | 45.1b; `stream.test.ts` (worker bundle passes the export scan) | served (default, owner to confirm) |
| R71 | — | — | later: deferred scatter |
| R72 | §3.7 | 45.6 (worker = main thread, deterministic) | served |
| R73, R74 | §3.7 reference producers | 45.6 | partly: 46b mesher and case pass |
| R75–R77 | §3.7 | 45.6; `derived.test.ts`; slice proof 45.7 (§6) | served (placeholder rules) |
| R78, R80 | — | — | superseded by R77 |
| R79 | §1 replacement 3 | 45.6 | replaced (owner chooses) |
| R81 | §3.7 render solid (density ≥ 128) | 45.6 | served |
| R82 | §3.7 occupancy, chunk-tree flags | 45.6, 45.7d; `derived.test.ts` | served (chunk, brick and tree-node flags) |
| R83 | §3.7 dependency | 45.6 | superseded by Q-c |
| R84, R85 | §3.7 mips | 45.6; `derived.test.ts` | served (paint colour waits for O16) |
| R86 | §3.7 instance sections | 45.6 | served at format level (§7a sections) |
| R87–R90 | — | — | later: 46b/46c (not storage formats) |
| R91 | §3.7 vertex slots + weights | 45.6 | served |
| R92 | — | — | later: paint storage O16 (47b) |
| R93–R96 | §3.7 prop channel | 45.6; `derived.test.ts` | served |
| R97–R99 | — | — | later: 46d |
| R100 | §3.7 nav | 45.6 | partly: the walk graph is 46d |
| R101, R102 | §2.2 category | — | later: 46d/47b/47c |
| R103 | §3.7 light coverage | — | later: 46d / camera |
| R104 | — | — | later: 46d (O19) |
| R105 | §3.7 collision | 45.6 | partly: Rapier churn in 46a |
| R106 | — | — | later: 48a |

**Not served yet, and where each goes:**
- **46a:** R10 (with 48), R30–R32, R40, R43, R45 and R65, together with 47a/47c.
- **46a / 46c:** R66 browser cache, R105 Rapier churn.
- **46b:** R14, R73, R74, R87–R90.
- **46c:** R27 and R28 (the material model; the id width is set).
- **46d:** R97–R101, R103 and R104.
- **47b:** R92.
- **48a:** R106.
- **49:** R26, R41, R42 and R61.

---

## 5. Defaults chosen, owner to confirm

There are 44 such entries in the plan's decision log (§7). One line each, grouped by area.

**Process and tooling**
1. Staging backend: `tools/staging.sh`, a transient unit on 127.0.0.1:4180/4181, its own data root, a 6 GB cap (45.0).
2. Voxel code lives in `packages/voxel` (`@thirdlight/voxel`), pure; Node tooling sits in `tools/voxel-bench/` (45.1b).
3. fzstd 0.1.1 and lz4js 0.2.0 are pinned root dev dependencies; fzstd is the proposed worker decoder (45.2b).
4. The browser streaming page reads from the bench's own range server, not staging (45.5b).

**Coordinates and record**
5. Integer cells: x, z ±32,768 and y ±8,192; chunk key below 2^35, y fastest inside a chunk (45.1b).
6. `VoxelRecord` fields and widths are the format; the category set (Q-a option 1) and orientation meaning stay provisional (45.1b, 45.8a).
7. Vertical bounds are the coordinate bounds; the format stores no world base or height; stacks are aligned at y = 0 (45.3).

**Chunk store and codec**
8. A surface voxel is one whose shape differs from its implied shape; only surface voxels store a density byte (45.2a).
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
29. Light coverage as bits + a partial list (bricks if 46d's tracer needs O(1) access); placeholder coverages (45.6).
30. Collision input as boxes in 1/16 cell + the ground trimesh; nav input as blocking bits + standable cells (45.6).
31. Mesh buffers: 20-byte vertices (24 when a chunk's material table has more than 256 slots), u16/u32 indices, two surfaces, 8-byte instances with `replacesBase` (45.6, 45.7d).
32. Voxel mips: a node has the chunk's form; mean density, dominant material; stale ancestors rebuilt lowest first (45.6).
33. Prop lighting channel: a coverage byte a cell, rebuilt from the prop list, never saved (45.6).

**Format gaps closed (45.7d)**
34. Readers name the tile they expect; another world, grid, layout, edge, footprint or region is refused (45.7d).
35. Codec and region upgrade steps: add-only registries keyed by the version lifted from; region steps lift the
    index only (45.7d).
36. World data has one encoding; the measurement encodings are read only by the bench entry (45.7d).
37. Set/dig cell lists in x, z, y order, each cell once (45.7d).
38. Material ids are 23 bits in the 32-bit record (8,388,607 a world), u24 at rest; category 4 bits, orientation
    5 bits (45.7d).
39. Orientation = one of 24 axis rotations, `face(k >> 2) · spin(k & 3)`, PROVISIONAL until 46b (45.7d).
40. The world manifest lists its region files; a listed one that cannot be read is damaged, an unlisted one air
    (45.7d).
41. Chunk-tree flags from the chunks' derived occupancy; undo answers carry their edit's box (45.7d).

**Review fixes (45.8a)**
42. Every save entry records the player's changed cells (a delta, or a whole-chunk form plus a changed-cell mask,
    the smaller); `save` on a changed base writes only those cells (45.8a).
43. The base hash covers the base form, frozen as the chunk codec v1 canonical bytes of the content, whatever codec
    version stores it (45.8a).
44. Raw record values carry a record value form (1 = the u32 23/4/5) in region, undo, save and override bytes; the
    split stays 23/4/5; O15/O16 may need per-voxel bits, owner decides (45.8a).

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

**Limits observed** (placeholder rules and meshes; 46b's catalogue and mesher replace them):
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
  when the chunk's material table has more than 256 slots (`surfaceStride`, §3.7); §5 default 31 now says so. No
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
- **G7 — material, orientation and category values. Closed in 45.7d (defaults chosen, owner to confirm).**
  - *Material id space (O12, R27).* The record keeps one 32-bit value: material 23 bits, category 4, orientation
    5 (§2.2), so a world names up to 8,388,607 materials, a format width rather than a small count, at no cost per
    cell or in memory. At rest the material plane is u24: +1 byte a palette entry. A full 32-bit material field was
    measured too: the 48-bit record value it needs makes a cell delta 9 bytes instead of 7 and an apron or
    assembly-block cell 8 bytes instead of 4. Numbers in the plan (**45.7d format gaps**).
  - *Orientation.* One of the 24 axis-aligned rotations (0–23, 0 the identity, `orientationMatrix`), others
    refused; PROVISIONAL until 46b's role and case catalogue.
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
