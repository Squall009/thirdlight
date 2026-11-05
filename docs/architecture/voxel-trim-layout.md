# Trim layout for detail pieces — DRAFT — not v1 (v0)

Status: **DRAFT — awaiting owner approval (46c hard stop); nothing builds on it as final.** No kit pipeline,
Blender template, spec sheet or art-factory graph treats these numbers as fixed until the owner approves them.
Sources: [plan 45](../plan-phase-45.md) §1 (one standard layout, overlays in world space), §1d (texel density,
field, strips, caps, tiers), §7 owner 2026-11-02 (R112), §7a (trim optional, own bakes allowed); requirements
[R73, R87, R90, R112](voxel-format-requirements.md); the kit format (`project-model` `voxel-kit.ts`, `trimLayout`)
and the draft case catalogue (`cases-draft-catalogue.ts`, archived in `archive/removed-phase-46c/`). Open questions for the owner are in §12.

## 1. Scope

- **Detail pieces only (R112).** The pieces the case pass adds on top of the voxel surfaces: beams, banister rails
  and posts, soffits, mouldings, running boards, foundation skirts, wall tops/ends/corners/bases, opening frames
  (jamb, head, sill, threshold), pillar bases/capitals/shafts, roof eaves/ridges/verges.
- **Never base surfaces.** Terrain and construction voxels use tileable texture arrays (wall, floor, ceiling
  surfaces chosen by role and face direction), mapped triplanar. They never sample a trim sheet.
- **Not props.** Doors, window leaves, glass, shutters and hardware are props with their own UVs (§1d); the trim
  layout covers only the opening's frame.

## 2. Two ways to texture a kit (both allowed, §7a)

| | A. Trim layout (this spec) | B. Own bakes + material arrays |
|---|---|---|
| Kit says | `trimLayout: "detail-trim"` | no `trimLayout` |
| Look comes from | a texture set painted in this layout | the cell's material arrays (the same tileables the walls use) |
| Piece-specific relief | none: the sheet's normal/height only | the piece's own sculpt bakes (normal, local AO) on a 2nd UV set |
| UV0 | regions of this layout, U from world run distance | run coordinates at the material's own repeat (U as §5) |
| UV1 | not used | unique per piece, for its bakes only (never colour) |
| Swap a texture set | any set in this layout, no re-export | any material, no re-export (bakes stay with the mesh) |
| Cost | 3 maps | 3 material maps + 2 bake maps, normal blend in the piece's tangent frame |

**When to use which:** A for straight, repeating members (beams, rails, mouldings, frames, skirts, copings): cheap,
and every texture set dresses them. B for sculpted, irregular pieces (a carved capital, a rough stone quoin) where
the shape itself carries detail no strip can. In B the bake is local-only (no occlusion from neighbours), the low
mesh gets its own bake (the high's bake is not reused automatically), and the material normal is blended over the
bake normal in the piece's tangent frame because both use the run-mapped frame (§5). A kit may mix: some cases A,
some B (open question 7).

## 3. The sheet

| | Default |
|---|---|
| Size | **4096 × 4096 px = 4 m × 4 m** at the authored density |
| Texel density | **authored at 1024 px/m**, one density for every region |
| Tiers | the tier caps the resident top mip: **low 256 px/m** (1024², mip 2), **medium 512** (2048², mip 1), **high 1024** (4096², mip 0). One asset set, no per-tier copies |
| Memory per texture set (3 maps, ~1 B/px compressed, mips +⅓) | low ~4 MB, medium ~16 MB, high ~64 MB (§1d's "about 60 MB") |
| Gutters | **32 px** (3.1 cm) above and below every band, around every cap cell; clean to mip 5 (1 px); 8 px at the low tier's 1024² |
| Alignment | every band starts on a multiple of 32 px |
| U period | the sheet width: **4 m**. Repetition along a run is every 4 m, never every 0.5 m cell |
| v convention | glTF: v from the top. Blender: v from the bottom (= 1 − v); both given in §4 |

## 4. Regions and exact UV rectangles

Three kinds of region:
- **Field** (`F1`): tiles in U and in V over its own 1 m height (top meets bottom). Broad faces, and round
  members whose circumference is 1 m.
- **Strips** (`S50`, `S25`, `S12`): tile in U only. Each height comes twice: **plain** (also seamless top to bottom,
  so a round member can wrap it) and **profiled** (`p`: distinct worn/chamfered top and bottom edges, for faces of
  exactly the strip's height).
- **Caps** (`C50`, `C25`, `C12` × variants a–d): square cells that do not tile: log end grain, cut stone ends, any
  end face. A cap is shared by every piece with that end size, so it is not a unique region.

Rectangles are the usable pixels (gutters outside). A UV must stay half a texel (1/8192) inside them.

| Id | Kind | Metres (V) | Pixels x | Pixels y (top–bottom) | u | v glTF | v Blender |
|---|---|---|---|---|---|---|---|
| F1 | field | 1.0 | 0–4096 (tiles) | 32–1056 | tiles | 0.007812–0.257812 | 0.742188–0.992188 |
| S50 | strip plain | 0.5 | tiles | 1120–1632 | tiles | 0.273438–0.398438 | 0.601562–0.726562 |
| S50p | strip profiled | 0.5 | tiles | 1696–2208 | tiles | 0.414062–0.539062 | 0.460938–0.585938 |
| S25 | strip plain | 0.25 | tiles | 2272–2528 | tiles | 0.554688–0.617188 | 0.382812–0.445312 |
| S25p | strip profiled | 0.25 | tiles | 2592–2848 | tiles | 0.632812–0.695312 | 0.304688–0.367188 |
| S12 | strip plain | 0.125 | tiles | 2912–3040 | tiles | 0.710938–0.742188 | 0.257812–0.289062 |
| S12p | strip profiled | 0.125 | tiles | 3104–3232 | tiles | 0.757812–0.789062 | 0.210938–0.242188 |
| C50a–d | cap 0.5 × 0.5 m | 0.5 | a 32–544, b 608–1120, c 1184–1696, d 1760–2272 | 3296–3808 | a 0.007812–0.132812 (+0.140625 per cell) | 0.804688–0.929688 | 0.070312–0.195312 |
| C25a–d | cap 0.25 × 0.25 m | 0.25 | a 2336–2592, b 2656–2912, c 2976–3232, d 3296–3552 | 3296–3552 | a 0.570312–0.632812 (+0.078125 per cell) | 0.804688–0.867188 | 0.132812–0.195312 |
| C12a–d | cap 0.125 × 0.125 m | 0.125 | a 2336–2464, b 2528–2656, c 2720–2848, d 2912–3040 | 3616–3744 | a 0.570312–0.601562 (+0.046875 per cell) | 0.882812–0.914062 | 0.085938–0.117188 |
| — | reserved | | 3584–4096 / 3072–4096 / 2304–3072 / 0–4096 | 3264–3584 / 3584–3840 / 3776–3840 / 3840–4096 | | | |

Reserved space stays a neutral mid-grey (height 0.5, flat normal); a later layout version may add regions there
(add-only), never move the ones above.

```text
  4096 px = 4 m across; field and strips repeat along U
+--------------------------------------------------------------+    0
|  F1   field  1.0 m  (tiles U and V)                          |
+--------------------------------------------------------------+ 1088
|  S50  strip 0.5 m plain     (tiles U; V seamless, wraps)     |
+--------------------------------------------------------------+ 1664
|  S50p strip 0.5 m profiled  (tiles U; edges top/bottom)      |
+--------------------------------------------------------------+ 2240
|  S25  strip 0.25 m plain                                     |
+--------------------------------------------------------------+ 2560
|  S25p strip 0.25 m profiled                                  |
+--------------------------------------------------------------+ 2880
|  S12  strip 0.125 m plain                                    |
+--------------------------------------------------------------+ 3072
|  S12p strip 0.125 m profiled                                 |
+--------------------------------------------------------------+ 3264
|C50a    |C50b    |C50c    |C50d    |C25a|C25b|C25c|C25d| res  |
|0.5 m   |caps    |        |        +----+----+----+----+------+ 3584
|        |        |        |        |C12 a-d |  reserved       |
+--------+--------+--------+--------+--------+-----------------+ 3840
|  reserved (a later version may add regions)                  |
+--------------------------------------------------------------+ 4096
  each box is a band: 32 px gutter + region + 32 px gutter
```

## 5. How a piece maps

- **Square texels everywhere.** A face's V span in the sheet equals its real size: 1 m of face = 1024 authored px.
  Geometry is sized to the regions (§1d): a 0.25 m beam face uses a 0.25 m strip, not a squashed 0.5 m one.
- **U from world distance along the run.** Pieces are authored in their case orientation (front +z, run along +x,
  up +y; a vertical run follows +y, but see "vertical runs" below). Authored U = distance from the section's start ÷ 4 m (a 0.5 m section spans
  U 0–0.125). The engine adds the run offset from the instance's cell: U = (cell along the run × 0.5 m) ÷ 4 m +
  authored U, taken along the world direction of the piece's +x after its turn; a mirrored instance uses
  (cell + 1) × 0.125 − authored U, so U still grows along the world axis. Every section of a run reads the same world
  coordinate, so body, junction and termination sections join without a seam and the pattern repeats every 4 m.
  *As built (46c.10, for the owner's review):* the renderer adds the run offset per instance (`pieceU`) and makes U
  grow along the world's positive axis for every instance, turned or mirrored, so two cells of a run that a symmetric
  case placed differently still meet; text on a sheet then reads mirrored on faces seen from the negative side.
- **Vertical runs: built differently, owner to decide (question 11).** The draft's intent is "a vertical run follows
  +y": a post, quoin, wall end or jamb would take U up the member. As built (46c.9), the kit check's T4 and the
  renderer read U along the piece's **x only** (faces with |normal x| < 0.05; faces end-on to x take U across them from
  z and are not checked), so a post authored to the draft gets a T4 **err**. The placeholder kits therefore map
  vertical members **planar**: U from x (or z on faces end-on to x), V up the piece, at real size. Options: (a) T4 and
  the renderer learn the case's run axis and take U from y on y runs (the draft's intent; a pattern then runs up a
  post and repeats every 4 m up a tall pillar), or (b) this section says vertical members map planar (as built; no
  pattern along a post, the sheet's V detail runs up it).
- **V by region.** Each face across the run maps to one region at its real size. A profiled strip needs the face to
  be the strip's height (±2 %); a plain strip or the field accepts a narrower face, centred in the band.
- **Half a texel spare forces odd member sizes (built, owner to decide: question 12).** A UV must stay half a texel
  inside its band (§4), so a face exactly a band's height does not fit it. The placeholder kits use: boards and drip
  faces 0.124 m (S12p), ashlar courses and heads 0.248 m (S25p, S25), plinths 0.498 m (S50p); members a full 0.5 m
  cell tall (posts, jambs) take **F1**, not S50; a log wrapping F1 is a 12-gon of perimeter 0.99 m (Ø 0.32 m
  nominal); a cap is at most its cell less a texel. Options: (a) accept these sizes (as built), or (b) size each band
  a texel taller than its nominal height so faces of exactly 0.125 / 0.25 / 0.5 / 1 m fit (a new layout revision of
  §4's rectangles).
- **Round members wrap a plain region** whose height is their circumference: nominal diameter 0.04 m → S12, 0.08 m →
  S25, 0.16 m → S50, 0.32 m → F1 (each a polygon a little under that perimeter, see above). The wrap seam faces down or
  toward the wall. A member that does not wrap (the log kit's Ø 0.14 m post, the half-logs of a wall face) maps its
  faces planar into a region tall enough for its height.
- **Caps by end.** An end face (termination section, free post top, log end) maps once into the cap cell of the
  next size up (≤ 0.125 → C12, ≤ 0.25 → C25, ≤ 0.5 → C50, each less a texel), at real size, centred, authored on
  cell `a`. The draft's default is that the engine moves it to b/c/d by the instance's variant hash (open question 6);
  **not built**: every cap draws from cell `a` today, and b–d stay unused.
- **Run-less pieces** (`run: null` cases: floor corner, pillar single, roof peak) map their faces planar: U from
  the world coordinate along the piece's +x, V from the vertical (or +z on horizontal faces), into the field or a
  plain strip, so they still meet their neighbours' texture.
- **Corners** turn the run axis: the two runs meet at a mitre with U independent on each side; profiled strips keep
  their edges at the same heights so the mitre lines up. **Built differently, owner to decide (D481, role spec
  question 3):** a piece carries one run axis for its world U (one `pieceU` offset an instance), so a corner piece
  cannot give both faces run U. The log corner carries its crossing log ends only and leaves both faces bare; the
  stone quoins map planar (as vertical members above). Options: a second U offset per face, or two pieces in a
  corner cell.
- **Variants** (the kit's weighted variants, chosen by the world-cell hash) change the mesh, never the regions: all
  variants of a section use the same regions for the same faces, so a variant swap or a high → low switch never
  jumps the texture.
- **Join profiles** (section end outlines): each outline edge's face uses the same region on both sides of a join.

## 6. Maps and channels

| Map | Channels | Space |
|---|---|---|
| Albedo | RGB base colour, no baked lighting; A unused (opaque) | sRGB |
| Normal + height | RGB tangent-space normal, **OpenGL (+Y green up)** as glTF; **A height** | linear |
| ORM | R ambient occlusion (local cavity only), G roughness, B metalness | linear |

- Height in the normal map's alpha is the material model's standard layout (§1c) and what wetness reads to fill
  crevices first (R111). Today's trim sheets and layered surfaces keep height in the albedo's alpha (open
  question 2); the regions above do not depend on which map carries it.
- **One height scale for the whole sheet** (default 0 = 0 m, 1 = 0.05 m), so height blends behave the same on every
  region (open question 9).
- Gutters are filled in **every** map: field and plain strips with their wrap, profiled strips and caps with their
  edge pixels repeated.
- Shipped as KTX2 like every engine texture; the compressed formats per map are 46d's choice.

## 7. Materials and blends on pieces

- **Default: the cell's material.** A piece draws with the texture set of the material of the voxel it stands on,
  read from the same per-chunk material + wetness grid the base surfaces blend from, so a run that changes material
  mid-wall blends its trim the same way the wall does, and wetness darkens it alike.
- **Another material per case (R112).** A kit may say a case uses another material type: a stone kit's beams in
  wood, its lintels in a darker stone. Needs an add-only field in the kit format (not built; open question 8).
- **A blend.** A piece may blend two texture sets by height (e.g. stone + moss toward the base). Because both sets
  use this layout, the same UVs read both; no second UV set.
- **Paint overlays** (dirt, moss, snow) stay world-projected, bi-planar with height in alpha (§1): they cross pieces,
  base surfaces and terrain without seams and never use the trim UVs.

## 8. Interchangeability

- A kit says which layout its UVs follow (`trimLayout`, the layout id `detail-trim`; the version comes with the
  approved spec). A texture set says which layout it was painted for. **Any set of the layout dresses any kit of the
  layout**: oak, maple and a burnt oak dress the same log kit with no re-export.
- One material type, one Texture Designer graph rendering straight into the layout; variants are parameter sets
  (§1d). Graphs are art-factory's, made from a request doc after approval (46c.17).
- Region ids, sizes and positions are fixed by the layout version; a set may leave reserved space empty but never
  uses it for its own regions.

## 9. Anti-tiling inside the layout

- Repeat every 4 m along a run (sheet width), not every cell.
- Plain and profiled pairs at each height give two looks per height without new geometry.
- Four cap variants per size, picked by the world-cell hash (stable under edits elsewhere).
- Authoring guidance: no single eye-catching mark (one big knot, one crack) in a strip; spread features so a 4 m
  repeat reads as texture.
- Not in the layout (owner, §1d "for now"): macro noise, per-run U offset and tint jitter, hex-tile sampling. They
  stay proposals, added only if repetition shows in practice.

## 10. Kit check rules (kits with `trimLayout` only)

`project-model` `voxel-kit-check.ts`; the last column says what is built today (46c.8, 46c.9).

| Row | Rule | Level | Built |
|---|---|---|---|
| T1 | Every UV0 lies inside one region's rectangle (half-texel inset); no triangle straddles two regions | err | yes |
| T2 | No UV0 in reserved space or a gutter | err | yes |
| T3 | Square texels: a face's V span × 4 m equals its real size ±2 % | warn | yes |
| T4 | Run density: authored U advances 0.25 per metre along the run ±2 %; a section starts at U 0 | err | along the piece's x only, on faces not end-on to x (§5 vertical runs) |
| T5 | Profiled strips: the face is the strip's height ±2 % | warn | yes (a region's V spans taken together) |
| T6 | Caps: end faces in the cell of the right size, on cell `a`, inside it at real size | warn | yes, each end face on its own |
| T7 | High and low (and all variants) use the same region for the same face | warn | yes |
| T8 | Faces meeting at a join profile use the same region on both sides | warn | yes, along the case's run axis; cases without a run skipped |
| T9 | A texture set for the layout: 4096² (or a power-of-two downscale), three maps present, gutters filled, normal green up | err | **not built**: the kit format names no texture set yet; reported as info |
| T10 | Info: regions each piece uses, its UV area per region | info | yes |

Kits without `trimLayout` are meant to get the B checks: UV1 present, in 0–1, non-overlapping (bakes need unique
UVs). **Not built** (46c.8 kept the trim rows to opted-in kits); such a kit gets no UV rows today.

## 11. Worked examples: the two placeholder kits

The placeholder kits (46c.9) draw with the layout's **debug texture set**: each region a distinct hue with its id
printed, a 3.125 cm checker (1/16 cell) to show stretching, a U tick every 0.125 m and the cell number every 0.5 m,
gutters and reserved space magenta. Any of the layout errors above shows up as a wrong colour, a stretched checker or a
jump in the numbers at a section join.

These are the kits as built (`tools/voxel-bench/kits/make_placeholder_kits.py`, 46c.9/46c.10), all path A. Sizes
are the built ones (§5: half a texel spare). Vertical members map planar (§5, question 11).

**Log kit (wood):**

| Case / piece | Faces → region |
|---|---|
| wall-plain body: two half-logs Ø 0.24 m on the face, one a 0.25 m course | bark **S50** |
| wall-thin body: the same half-logs on both faces | bark **S50** |
| wall-top ×2 variants: half-log Ø 0.40 / 0.36 m on top, 7 cm overhang at free ends | bark **F1**; end grain at start/end/single → **C50** |
| wall-end body: log stubs Ø 0.22 m out of the end, the courses on both faces | stubs **F1**, their ends → **C25**; courses **S50** |
| wall-corner body: crossing log stubs along x and z | stubs **F1**, ends → **C25**; the two faces bare (D481, §5 corners) |
| beam: log Ø 0.32 m nominal (12-gon) along x | bark wraps **F1**; ends at start/end/single → **C50** |
| banister-rail: two poles Ø 0.08 m | wrap **S25**; ends → **C12** |
| banister-post: Ø 0.14 m, the cell's height (vertical) | sides planar **F1**, U from x/z, V up; top → **C25** |
| running-board, moulding: 0.124 m hewn board | front **S12p**, edges **S12**; cut ends **S12** |
| foundation-skirt: 0.248 m board at the foot | front **S25p**, edges **S12** |
| soffit: boards 0.24 m deep under the slab | underside **S25**, front edge **S12** |

No opening frames and no wall-base: those cases draw the role fallback or the base surface.

**Stone kit (dressed stone):**

| Case / piece | Faces → region |
|---|---|
| wall-plain, wall-thin ×2 variants: two ashlar courses 0.248 m, joint staggered (thin: both faces) | faces **S25p**, edges **S12**, joint faces **S25** |
| wall-top: coping 0.49 m wide, 0.124 m drips | top **S50**, drips **S12p** front and back, chamfers **S12**; ends → **C50** |
| wall-base, foundation-skirt: plinth 0.498 m, 4 cm proud | face **S50p**, top **S12** |
| wall-corner, wall-end: quoins 0.248 m a course, 2 cm proud (vertical) | faces **S25p**, returns **S25**, tops/bottoms **F1**; planar |
| moulding: cornice, 0.124 m face | face **S12p**, chamfer and soffit **S12**; cut ends **S12** |
| opening-jamb: 0.125 × 0.25 m, the cell's height (vertical) | reveal and faces **F1**, planar |
| opening-head: underside 0.248 m deep | underside **S25**, front and back **S12p** |
| opening-sill / opening-threshold: 0.1 / 0.03 m high | top **S25p**, noses **S12** |
| opening-single: head, sill and two short jambs | as head and sill; jambs **S50**, planar |

No pillar pieces and no beam: those cases draw the role fallback or the engine stand-ins. The wooden beam with a
per-case material override (§7) is not built: the kit format has no override field yet (question 8).

Triangles, LOD pairs, texture sizes and file sizes of these kits are reported with 46c.9 and 46c.10 (log 29 pieces,
896 / 433 triangles high / low, GLB 104,700 B; stone 20 pieces, 360 / 360, 40,276 B; no textures embedded). Until 46d
gives texture sets, a trim kit draws with its layout's **generated debug set** (1024², the low tier size, not painted;
built in the renderer, shared by every trim kit).

## 12. Open questions for the owner

1. Sheet 4096² (4 m × 4 m) at 1024 px/m authored, or 4096 × 2048 with fewer regions?
2. Height in the **normal** map's alpha (§1c, R111) as drafted, or in the albedo's alpha like today's trim sheets?
3. Gutters of 32 px (clean to mip 5) and the U period of 4 m: right, or longer repeats (8 m on a wider sheet)?
4. Two strips per height (plain, profiled): enough? Add a 0.0625 m strip pair (pegs, thin edges) in the reserved
   space?
5. Field of 1.0 m (wraps a 0.32 m log): right height, or 0.75 m?
6. Cap variants moved b/c/d by the engine's hash (a small shader step), or only by kit variants the artist UVs?
7. Path B (own sculpt bakes on a unique UV1 + material arrays): allowed for any case, or only where A cannot work
   (the owner's "unique UVs avoided" rule)? May one kit mix A and B?
8. A per-case material override in the kit (stone kit, wooden beams): approve the idea (an add-only kit field)?
9. One absolute height scale for the sheet (0–5 cm), or per region?
10. Round members limited to the four wrap diameters (0.04 / 0.08 / 0.16 / 0.32 m): acceptable for art?
11. **Vertical runs (§5, T4; 46c.9).** Should T4 and the renderer learn the case's run axis so posts, quoins, wall
    ends and jambs take U up the member (the draft's intent), or do vertical members map planar, U from x, as built?
12. **Band sizes and the half-texel spare (§5; 46c.9).** Accept the odd member sizes the bands force (0.124 m boards,
    0.248 m courses, full-height members on F1, a 12-gon log of perimeter 0.99 m), or size each band a texel taller
    so faces of exactly 0.125 / 0.25 / 0.5 / 1 m fit?

## 13. What you are approving

- [ ] Scope: detail pieces only; base surfaces and terrain never use trim (R112); props keep their own UVs.
- [ ] Both paths allowed: A (this layout) and B (own bakes + material arrays), chosen per kit.
- [ ] Sheet: 4096², authored 1024 px/m, tiers cap at 256/512/1024 px/m, 32 px gutters, U period 4 m.
- [ ] Regions and their rectangles in §4 (field 1 m; strips 0.5/0.25/0.125 m plain + profiled; caps 3 sizes × 4).
- [ ] Mapping: U from world distance along the run (growing along the world's + axis, §5), V by region at real
  size, caps by end, round wrap rule; vertical runs as you answer question 11, corners as you answer role spec question 3 (D481).
- [ ] Maps: albedo / normal + height (A) / ORM, OpenGL normals, one height scale.
- [ ] Interchangeability: any texture set of the layout dresses any kit of the layout.
- [ ] Kit check rows T1–T10 (warn vs err as listed; T9 and the B checks are not built yet).
- [ ] Your answers to §12.
