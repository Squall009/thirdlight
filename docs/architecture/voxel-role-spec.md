# Role spec — DRAFT — v1 candidate (edge model)

Status: **DRAFT — awaiting owner approval (46c hard stop); nothing builds on it as final.** No kit pipeline,
Blender template, spec sheet, manual guide or art-factory request treats this case list as fixed until the owner
approves it. The owner's 2026-11-04 review of the first draft (46 cases, pieces over flat walls) replaced it with this
edge model; the earlier text is in git history. This page is written from the engine's edge catalogue
`edges-draft` v1 (21 cases; `packages/voxel/src/kit-case-catalogue.ts`), and a test
(`tools/voxel-bench/role-spec-doc.test.ts`) fails when this page and the catalogue disagree on a case, its marking or
its facts. Sources: [plan 46c](../plan-phase-46c.md) §6b and the decision log (OWNER 2026-11-04 entries, R1–R5
results); [plan 45](../plan-phase-45.md) §1, §7 (owner 2026-11-02: the ten stored roles); the
[format spec](voxel-format-spec.md) §2.2 (the voxel value) and §3.7. The texture layout is its own draft:
[voxel-trim-layout.md](voxel-trim-layout.md).

**How to read this page.** §1–§3 say what is stored and the one rule (flat faces get no piece). §4 explains the
diagrams. §5–§8 list the 21 cases: edges and corners, roof edges, damage, beams and banisters; each case has the same
block of facts (generated from the engine) followed by a small diagram. §9–§13 are for kit artists: one mesh for
several cases, stagger, detail levels, what a kit must provide, Blender conventions. §14 says what moved to other
phases, §15 lists known gaps, §16 the questions only you can answer, §17 what approving this page means.

## 1. Roles are stored; everything else is read from the arrangement

A voxel stores four things (format spec §2.2): a material, a **role**, a shape and a wetness. Ten roles are assigned
(owner 2026-11-02); values 10–15 are refused until a later spec assigns them.

| Role | Value | Kind | Its shape means | What draws it |
|---|---|---|---|---|
| air | 0 | open | — | nothing |
| terrain | 1 | terrain | fill (0–15, a smooth surface) | the terrain mesher (46b); never kit pieces |
| liquid | 2 | liquid | fill level | a later phase; open for pieces |
| wall | 3 | construction | integrity (15 intact) | plain voxel faces + edge pieces |
| floor | 4 | construction | integrity | plain voxel faces + edge pieces |
| roof | 5 | construction | integrity | the roof mesher's planes where the cells form a 45° stair (§6), else voxel faces; edge pieces off the planes |
| foundation | 6 | construction | integrity | plain voxel faces + edge pieces |
| stair | 7 | construction | integrity | plain voxel faces + edge pieces (a nosing is a top edge) |
| pillar | 8 | construction | integrity | plain voxel faces + edge pieces |
| opening | 9 | open | — | nothing yet: a gap a door or window prop fills (47a); its rim is the walls' edges |

**Construction differs from terrain and liquid in one way that matters here:** a construction cell is a whole
0.5 m block or nothing. Its shape field is not a fill but its **integrity** (owner 2026-11-04): 15 is intact, lower
values are damage stages (§7), air is broken. Every engine reader (collision, light, occupancy, navigation, the
level-of-detail downsample) treats a construction cell of any integrity as a whole block until it is air. Terrain and
liquid keep shape as a fill. A construction cell painted with a smooth brush is written whole (integrity 15).

**Nobody paints a piece.** No role names an edge, a corner, a ridge, a beam or a banister. The engine reads them from
the cells round each place, so building or digging one cell changes the pieces near it and nowhere else, in the editor
and in a running game alike. Nothing stores a case.

## 2. The one rule: flat faces get no piece

Walls, floors, stairs, pillars, foundations and flat roofs are **plain voxel faces** with the material's tiling
texture (texture layout §2). No piece is ever placed on a flat face. Detail pieces go only **where faces meet**:

- on a **lattice edge** (the 0.5 m line where four cells meet) that the cells round it make exposed;
- on a **lattice corner** (the point where eight cells meet) the same way;
- on the edges of a **roof's planes** (ridge, eave, verge, hip, valley);
- on a **damaged** cell and on the faces opening toward it;
- on the **beam and banister** cells (kept as built).

Each piece is its own instance a 0.5 m edge or a corner: no merged run geometry, no hand-made lengths. Far away the
pieces go and the building is flat square voxels (§11).

## 3. Solid, open and who owns a piece

- **Solid:** any construction role, and terrain filled to its surface. **Open:** air, liquid, opening.
- **Outer edge:** 1 of the 4 cells round it solid. **Inner edge:** 3 of 4 solid. **2 side by side:** a flat face, no
  piece. **2 diagonal:** two outer edges, one owned by each cell (never more than two pieces on one edge).
- **Outer corner:** 1 of the 8 cells round it solid. **Inner corner:** 7 of 8 solid. Any other count, and a corner
  where outer and inner edges meet (a mixed corner), gets no corner piece: the edge pieces overlap there.
- **Top / bottom / vertical** comes from gravity: a horizontal outer edge is a *top* edge when its solid cell is below
  it and a *bottom* edge when it is above; an inner edge is *top* when its open cell is below (wall meets ceiling) and
  *bottom* when it is above (wall meets floor). No vertical flip is ever applied to a case.
- **Owner.** An outer edge or corner belongs to its one solid cell; an inner one to the cell diagonally opposite the
  open cell. The owner's **material names the kit** that draws the piece. A seam between two materials on a flat face
  gets no piece (the shader's material blend draws it).
- **Where no piece goes:** round a terrain cell with any fill (where a building meets the ground, the terrain
  material's dressing draws the contact, 47b); round a roof plane cell (the roof mesher draws that surface, §6); round
  a debris cell (§7); round a beam or banister cell (they are thin; no faces meet there); on a buried cell.

## 4. Reading the diagrams

Every case is written in **its own orientation**: the open side toward **+z** (the front); a vertical edge or a
corner opens toward **+x and +z**; up is **+y**; an edge runs along **x**. The engine turns it into place by a
**yaw** of 0–3 quarter turns about +y (each turn takes +x to +z). Diagrams are small cuts of the cells round the place:

<!-- legend -->
| Symbol | Meaning |
|---|---|
| `#` | a solid cell (construction, or terrain for the counts; a piece never goes where terrain touches) |
| `.` | an open cell (air, liquid, opening) |
| `*` | the edge (seen end-on) or the corner the piece sits on |
| `O` | the cell that owns the piece (its material's kit draws it) |
| `R` | a roof cell; `r` a roof plane cell the roof mesher draws |
| `x` | a damaged cell (integrity below 15); `f` an intact face toward it |
| `W` | a wall cell under or beside the roof; `P` a banister post |
| `G` `E` `g` `h` `v` | roof-edge pieces: ridge, eave, verge (gable edge), hip, valley |
<!-- /legend -->

A **cut across an edge** shows the 4 cells round a horizontal edge looking along x (back −z on the left, front +z on
the right, up on top). A **plan** (from above, x to the right, front +z down) shows the 4 cells round a vertical edge.
A **corner** is two plans, the layer above the corner and the layer below.

## 5. Edges and corners (10 cases)

Placed by the edge pass, which reads one cell round each cell. One case a slot; a cell owns at most its 12 edges and
8 corners. Pieces span the full 0.5 m of their edge; a corner piece sits over the lattice point where its edges end.

#### `edge-out-top` · REQUIRED

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** own mesh: a rounded strip over the top edge, from the top face to the front face
- **Catalogue note:** outer edge, the solid cell below it: a wall top, a stair nosing, a floor edge

A wall's top edge, a floor slab's edge, a stair's nosing.

```text
 cut across the edge (looking along x)
          back  front
   above   .  |  .
          ----*----
   below   O  |  .      O = # (the one solid cell, below the edge)
```

#### `edge-out-vertical` · REQUIRED

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** alias of `edge-out-top`, rotation 9 (ZM90, a quarter turn about −z): the top edge's strip turned up the outside corner
- **Catalogue note:** outer vertical edge: an outside wall corner, a jamb

An outside wall corner, a door or window jamb's edge.

```text
 plan (x →, front +z ↓), the vertical edge at *
          −x     +x
   back    O  |  .      O = # (the one solid cell)
          ----*----
   front   .  |  .
```

#### `edge-out-bottom` · REQUIRED

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** alias of `edge-out-top`, rotation 5 (X90, a quarter turn about +x): the top edge's strip turned under the underside edge
- **Catalogue note:** outer edge, the solid cell above it: a lintel underside, an overhang

A lintel's underside edge, an overhang, a floor's underside edge.

```text
 cut across the edge
          back  front
   above   O  |  .      O = # (the one solid cell, above the edge)
          ----*----
   below   .  |  .
```

#### `edge-in-top` · OPTIONAL

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** alias of `edge-in-bottom`, rotation 5 (X90, a quarter turn about +x): the floor cove turned up under the ceiling
- **Catalogue note:** inner edge, the open cell below it: wall meets ceiling

Where a wall meets the ceiling over it.

```text
 cut across the edge
          back  front
   above   O  |  #      the ceiling (O owns it: diagonally opposite the open cell)
          ----*----
   below   #  |  .      the wall behind; the room in front
```

#### `edge-in-vertical` · OPTIONAL

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** alias of `edge-in-bottom`, rotation 9 (ZM90, a quarter turn about −z): the floor cove turned up the inside corner
- **Catalogue note:** inner vertical edge: an inside wall corner

An inside wall corner.

```text
 plan, the vertical edge at *
          −x     +x
   back    O  |  #
          ----*----
   front   #  |  .      the open cell; O diagonally opposite it
```

#### `edge-in-bottom` · OPTIONAL

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** own mesh: a cove where the wall meets the floor, in the open cell
- **Catalogue note:** inner edge, the open cell above it: wall meets floor, a riser foot

Where a wall meets the floor in front of it; a stair riser's foot.

```text
 cut across the edge
          back  front
   above   #  |  .      the wall behind; the room in front
          ----*----
   below   O  |  #      the floor (O owns it: diagonally opposite the open cell)
```

#### `corner-out-top` · REQUIRED

- **Placed by:** the edge pass, one piece a lattice corner, yaw 0–3
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** own mesh: a rounded cap closing the three strips at a top corner
- **Catalogue note:** outer corner, the solid cell below it: a box top corner

A box's top corner: where a top edge meets a vertical edge and another top edge.

```text
 layer above the corner      layer below
      −x   +x                   −x   +x
 back  .  .                 back O  .
 front .  .                 front .  .       one solid of 8: O, below and behind the corner *
```

#### `corner-out-bottom` · REQUIRED

- **Placed by:** the edge pass, one piece a lattice corner, yaw 0–3
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** alias of `corner-out-top`, rotation 5 (X90, a quarter turn about +x): the top corner's cap turned under
- **Catalogue note:** outer corner, the solid cell above it: a box bottom corner

A box's bottom corner (an overhang's corner, a lintel's end underneath).

```text
 layer above the corner      layer below
      −x   +x                   −x   +x
 back  O  .                 back .  .
 front .  .                 front .  .       one solid of 8: O, above and behind
```

#### `corner-in-top` · OPTIONAL

- **Placed by:** the edge pass, one piece a lattice corner, yaw 0–3
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: nothing is added (the faces show as they are)
- **Catalogue note:** inner corner, the open cell below it

Where two walls and the ceiling meet in a room's corner (seven of eight solid, the open cell below).

```text
 layer above the corner      layer below
      −x   +x                   −x   +x
 back  O  #                 back #  #
 front #  #                 front #  .       the open cell below in front; O diagonally opposite
```

#### `corner-in-bottom` · OPTIONAL

- **Placed by:** the edge pass, one piece a lattice corner, yaw 0–3
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: nothing is added (the faces show as they are)
- **Catalogue note:** inner corner, the open cell above it

Where two walls and the floor meet in a room's corner (the open cell above).

```text
 layer above the corner      layer below
      −x   +x                   −x   +x
 back  #  #                 back O  #
 front #  .                 front #  #       the open cell above in front; O diagonally opposite
```

## 6. Roofs: the roof mesher and its roof edges (5 cases)

A sloped roof is built from **roof cells laid as a 45° stair** (the build menu's 2 m and 4 m stair-step roofs). The
stair cells stay the data for light, occupancy and navigation. The **roof mesher** draws them, like the terrain mesher
draws terrain, as **flat sloped planes** with the roof material's tiling texture, mapped up the slope:

- **Which cells (the 45° rule).** A *plane cell* is an intact roof cell with nothing solid above it that rises in at
  least one of the four horizontal directions: a roof cell one up and one across, or one down and one across the other
  way. A cell rising one way with a roof cell beside it on its low side at the same level is a flatter stair than 45°
  and is left out (D500). Damaged roof cells are left out (a hole, §7). **Every cell left out keeps its voxel faces**
  (the fallback), so a roof never disappears.
- **The surface.** The top runs through the stair's outer corners; the underside one cell lower, or on the voxel's
  floor where a wall carries it (so a gable or eave wall's steps are filled under the verge). Ridges, hips and a
  pyramid's apex take the lower of two planes, valleys the higher. Planes stop at a non-roof neighbour: a wall or
  chimney through the roof keeps its faces.
- **Only 90° hips and valleys in plan, 45° slopes.** Other slopes and plans keep voxel faces.
- **Collision** follows the drawn planes (a ramp, default chosen 2026-11-04, owner to confirm); light, occupancy and
  navigation keep the stair voxels.
- **Every level.** The mesher runs at every distance ring (planes read better than stairs far away); the roof-edge
  pieces, like all pieces, only near (§11).
- **No edge pieces round plane cells**: the roof's own edges below take their place. Roof-edge pieces are not
  staggered.

```text
 cut across a gable roof (x →, up ↑), the planes drawn through the stair's outer corners
              G
            r/\r          G  roof-ridge: where the two planes meet (one cell owns it; on an odd roof it is
          r/ r  r\r          centred on the middle cell, placed half a cell in and half a cell down)
        r/ r    r  \r     r  plane cells (their voxel faces are not drawn)
      E/ W        W  \E   E  roof-eave: the low edge of each plane, open below and in front
       W              W   W  the walls carrying the roof
```

#### `roof-ridge` · REQUIRED

- **Placed by:** the roof mesher, on roof plane cells
- **Roles:** roof
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** own mesh: a ridge cap over the line the two planes meet on
- **Catalogue note:** the top line of two roof planes meeting

```text
 cut across the ridge
        G
      r/ \r        the ridge cap sits over the line the two planes meet on
    r/     \r
```

#### `roof-eave` · REQUIRED

- **Placed by:** the roof mesher, on roof plane cells
- **Roles:** roof
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** own mesh: an eave lip under the plane's low edge
- **Catalogue note:** the lowest edge of a roof plane

```text
 cut across the eave (the plane rising toward −z in the case's own orientation)
     r\
       r\
         E        the lowest edge of the plane: open below and in front (+z)
```

#### `roof-gable` · REQUIRED

- **Placed by:** the roof mesher, on roof plane cells
- **Roles:** roof
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** own mesh: a verge board up the gable edge, along the slope (rising toward +x; the other side mirrored)
- **Catalogue note:** the sloped end of a roof plane at a gable: the verge

The verge: the sloped edge of a plane at a gable end. One mesh serves both slopes of a gable: author it rising
toward **+x**; the engine draws the other side **mirrored** (the variant word's mirror bit), with its winding kept
correct.

```text
 the gable end seen from the front (+z)
            /\
        g' /  \ g      g  the verge mesh as authored (rising toward +x)
          / WW \       g' the same mesh drawn mirrored
         / WWWW \
```

#### `roof-hip` · REQUIRED

- **Placed by:** the roof mesher, on roof plane cells
- **Roles:** roof
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** own mesh: a hip cap up the line the two planes meet on
- **Catalogue note:** an outside corner line of two roof planes

```text
 plan of a hip roof (x →, z ↓); h marks the hip lines (two planes meeting convex), G the ridge
   h . . . . . h
   . h . . . h .
   . . G G G . .
   . h . . . h .
   h . . . . . h
```

#### `roof-valley` · OPTIONAL

- **Placed by:** the roof mesher, on roof plane cells
- **Roles:** roof
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** own mesh: a valley board up the crease the two planes meet in
- **Catalogue note:** an inside corner line of two roof planes

```text
 plan of an L-shaped roof's inner corner; v marks the valley (two planes meeting concave)
   . . . . . .
   . . . . . .
   . . . v . .
   . . . . v .
   . . . . . v .
```

## 7. Damage: integrity and debris (3 cases)

The engine has no "damage" value: a construction cell's shape is its integrity (owner 2026-11-04). What lowers it and
when is **game logic**; the engine only shows the state.

- **Integrity 15:** intact. **8–14:** the `debris` piece. **1–7:** the `debris-heavy` piece (a kit with one debris
  piece dresses both). **Air:** broken: no debris; the faces and edge pieces round the hole draw as for any hole.
- **Only exposed damage shows.** A damaged cell with every face against solid stays a plain block (nothing hidden
  inside a mass).
- **The damaged cell's faces are left to its debris piece**; every intact face that opens toward it draws its face
  plus a `debris-face` piece (a broken rim), owned by the intact cell (its material's kit). Edges round a debris cell
  take no edge piece.
- **Collision, light, occupancy and navigation keep the cell whole until it is air** (owner).
- **Near only.** A level-1 cell made of damaged cells counts as intact, so damage shows in the nearest ring only.

#### `debris` · OPTIONAL

- **Placed by:** the debris rule, on an exposed damaged construction cell, in place of its faces
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** own mesh: a few chunks of rubble
- **Catalogue note:** a damaged cell, integrity 8–14: drawn by this piece in place of its faces

```text
 a wall seen from the front; integrity 12 at x
   # # # # #
   # # f # #      x  drawn by the debris piece (integrity 8–14), its own faces left out
   # f x f #      f  intact faces toward it: face + debris-face piece
   # # f # #
```

#### `debris-heavy` · OPTIONAL

- **Placed by:** the debris rule, on an exposed damaged construction cell, in place of its faces
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box · **Stand-in:** `debris`
- **Engine default kit:** own mesh: a low heap of rubble
- **Catalogue note:** a badly damaged cell, integrity below 8: drawn by this piece in place of its faces

```text
 the same wall; integrity 5 at x
   # # f # #
   # f x f #      x  drawn by debris-heavy (integrity below 8), or by the kit's debris piece if it has no heavy one
   # # f # #
```

#### `debris-face` · OPTIONAL

- **Placed by:** the debris rule, on an intact face opening toward a damaged cell
- **Roles:** every construction role
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** own mesh: a broken rim on the face opening to the damage
- **Catalogue note:** an intact face opening toward a damaged cell: its broken edge

```text
 cut through the wall at the damaged cell (front +z →)
   #  #  #
   #  f| x       the intact cell's face toward x carries a debris-face piece (placed by yaw, or tipped
   #  #  #       face-up / face-down for faces above or below the damage)
```

## 8. Beams and banisters (3 cases, kept as built)

Beams and banisters are not stored roles: the case window (the cells within two of a cell) reads them from the
arrangement, as built before the edge model and kept unchanged (owner: "stay as planned until the system is solid").
They are the only cases with run sections (single, start, body, end, corner, junction) and the only ones that replace
their cell's faces: a beam or banister cell draws only its piece, and collides and lights as its thin declared shape
(an open rail is open for every consumer). No edge piece goes on an edge such a cell touches.

#### `beam` · REQUIRED

- **Placed by:** the case window's rules (3), read from the arrangement
- **Roles:** wall, floor · **Inferred feature:** beam
- **Sections:** a run along its own x: single, start, body, end, corner, junction
- **Base:** suppress · **Coarse shape** (collision, navigation, light): bar
- **Engine default kit:** none: the engine's stand-in bar with its run sections (every kit's last fallback)
- **Catalogue note:** one cell out from a wall body, open above and below

```text
 cut across a beam (front +z →)
   #  .        the wall body behind; open above, below and in front
   #  O        O = the beam cell (a wall or floor cell one out from the wall)
   #  .
```

#### `banister-rail` · REQUIRED

- **Placed by:** the case window's rules (6), read from the arrangement
- **Roles:** wall · **Inferred feature:** banister
- **Sections:** a run along its own x: single, start, body, end, corner, junction
- **Base:** suppress · **Coarse shape** (collision, navigation, light): panel
- **Engine default kit:** none: the engine's stand-in panel with its run sections (every kit's last fallback)
- **Catalogue note:** a low thin run, open above: on a post, between posts or on a wider support

```text
 cut along a balcony edge (x →)
   .  .  .  .  .
   P  O  O  O  P    O  rail cells: a low one-cell-thin wall run, open above
   #  .  .  .  #    P  posts (banister-post) or a wider support under the rail
```

#### `banister-post` · REQUIRED

- **Placed by:** the case window's rules (1), read from the arrangement
- **Roles:** wall, pillar · **Inferred feature:** banister
- **Sections:** none: one piece a place (the kit names it `body` or `single`)
- **Base:** suppress · **Coarse shape** (collision, navigation, light): post
- **Engine default kit:** none: the engine's stand-in post (every kit's last fallback)
- **Catalogue note:** thin both ways on a support, under a rail

```text
 cut across a post
   .
   O      O  a thin cell open on its four sides, on a support, under a rail
   #
```

## 9. One mesh, many cases (aliases and the verge mirror)

Many cases are the same shape turned. A kit may say a case is drawn by **another case's mesh turned** by one of the 24
cube rotations (`alias: {case, rotation}` in the kit record; rotation numbers are fixed, `cube-rotations.ts`). A
rotation never mirrors, so normals and winding stay right. An alias may not have sections of its own, may not name
itself or another alias, and must name a case the kit has meshes for (the kit check reports every alias). Rotation 5
(X90) turns a top edge under into a bottom edge; rotation 9 (ZM90) turns a horizontal edge up into a vertical one.

| Case | Engine default kit | Log placeholder | Stone placeholder |
|---|---|---|---|
| `edge-out-top` | own (rounded strip) | own (round log, 2 variants) | own (chamfered / chipped block edge, 2 variants) |
| `edge-out-vertical` | = edge-out-top, 9 | own (log ends crossing a course) | = edge-out-top, 9 |
| `edge-out-bottom` | = edge-out-top, 5 | = edge-out-top, 5 | = edge-out-top, 5 |
| `edge-in-bottom` | own (cove) | own (a pole in the corner) | own (fillet) |
| `edge-in-top` | = edge-in-bottom, 5 | = edge-in-bottom, 5 | = edge-in-bottom, 5 |
| `edge-in-vertical` | = edge-in-bottom, 9 | = edge-in-bottom, 9 | = edge-in-bottom, 9 |
| `corner-out-top` | own (cap) | own (crossing logs) | own (corner block) |
| `corner-out-bottom` | = corner-out-top, 5 | = corner-out-top, 5 | = corner-out-top, 5 |
| `corner-in-top`, `corner-in-bottom` | none | none | none |

So a kit can cover all ten edge and corner cases with **three meshes** (an outer edge, an inner edge, an outer
corner). The **verge** is different: its two sides are mirror images, which no rotation gives, so the engine draws the
second side mirrored by itself (§6) and the kit authors one verge rising toward +x.

## 10. Stagger

Each edge and corner piece is moved by a small amount hashed from its cell, so a row of edge pieces reads hand-built,
not machine-straight: **1/64–1/32 cell** (0.8–1.6 cm) **into the solid**, along the bisector of its two faces, and
twisted at most **2°** about it (never more than the move hides). It never moves out of the faces, so no gap opens
between a piece and its faces. The hash reads the world cell, the level, the kit and which of the cell's pieces it
is: an edit elsewhere never moves a piece. Roof-edge, debris, beam and banister pieces are not staggered.

**Variants** work the same way: a case may have several weighted variants (two log diameters, two block chips); the
variant is hashed from the world cell, the kit and which of the cell's pieces it is, so the edges of one cell vary on
their own and nothing reshuffles when you build elsewhere.

## 11. Detail levels: pieces near, plain voxels from the middle ring out

Owner 2026-11-05: two states only, as in the reference — **detail pieces near, flat square voxel edges from the
middle distance outward.** There is no "simple piece" stage, so a kit authors **one mesh per piece** (no low version).

| Ring | Cells | Pieces | Surfaces |
|---|---|---|---|
| L0 (near) | 0.5 m | the kit's pieces (edges, corners, roof edges, debris, beams, banisters) | voxel faces, roof planes |
| L1 (middle) and coarser | 1 m and up | **none** | flat square voxels, roof planes |

Damage shows at L0 only (§7). The far field (no draw cut-off, cheap stand-ins for km-distant terrain) is 46d's.
*Built so in 46c.16a (derived 21): level 1 and coarser list no pieces; the `low` mesh left the kit format, the kit
check and the placeholder kits.*

## 12. What a kit must provide, and what the engine does without it

A kit belongs to a material type and draws the pieces of every cell whose material it binds.

- **Required (12):** `edge-out-top`, `edge-out-vertical`, `edge-out-bottom`, `corner-out-top`, `corner-out-bottom`,
  `roof-ridge`, `roof-eave`, `roof-gable`, `roof-hip`, `beam`, `banister-rail`, `banister-post`. An alias counts.
  Missing one is a kit-check **warning**; the place shows its plain square voxel edge (beams and banisters: the
  engine's stand-in shapes).
- **Optional (9):** the inner edges and corners, `roof-valley`, `debris`, `debris-heavy`, `debris-face`. Missing one
  is **info**: the faces show as they are; `debris-heavy` falls back to the kit's `debris`.
- **Per piece:** one mesh (drawn at L0 only), optional variants with weights,
  opaque game data (break, sound, … passed through to the game; the engine never reads it).
- **Engine fallbacks:** a material no kit binds draws the **engine default kit** (procedural, in code: rounded
  strips, coves, corner caps, roof boards, rubble; 11 meshes for 18 cases, 525 triangles in all).
  A case missing in a bound kit draws nothing (no other kit's piece stands in), except beams and banisters, which
  draw the engine's stand-ins.
- **Collision, navigation and light never read a piece.** They come from the voxels (and the roof planes).
- **Budgets** (placeholder defaults, reported by the kit check, never capped): edge ≤ 48 triangles, corner ≤ 64,
  roof edge ≤ 64, debris ≤ 160 (one mesh a piece).

## 13. Building a piece in Blender

These match what the engine draws, the kit check tests and `tools/voxel-bench/kits/make_placeholder_kits.py` writes:

- **Units and pivot.** Metres. The object's origin is the **centre of the owning cell**; the cell is −0.25 … +0.25 m
  on each axis. A piece must touch its cell (else an error: it draws beside it) and may reach half a cell past it
  (±0.5 m; roof-edge pieces a cell higher, since the planes run up to a cell above the voxel); past that a warning.
  Apply rotation and scale; leave the object at the origin.
- **Axes in the case's own orientation** (glTF, +y up): the open side (what shows) toward **+z**, the edge along
  **+x**, up **+y**; a vertical edge runs up +y and opens toward +x and +z. In Blender (Z up; the glTF exporter turns
  it): open side toward **−Y** (the Front view), the edge along **+X**, up **+Z**. The voxel body is behind, toward
  Blender +Y.
- **No hidden geometry.** Leave out faces that lie against the voxel body or under a roof plane. Pieces sit over the
  voxel's square edge (it is not chamfered), standing at most a few centimetres proud of the faces; the stagger moves
  them inward up to 1.6 cm, so a piece that stands less proud than that can sink under its faces in places (the stone
  placeholder's first edge did at 1.2 cm; it stands 3.5 cm proud now).
- **Roof pieces** follow the roof mesher's planes: the verge rising toward +x, the ridge written for the cell's high
  side (the engine centres it on odd roofs), the eave open toward +z with its plane rising toward −z, the hip and
  valley running from the cell's +x +z corner (low) up to its −x −z corner.
- **Names.** One GLB a kit, one node a piece, all at the file's origin: `<case>_<section>_v<k>_<high|low>`, e.g.
  `edge-out-top_body_v0_high`, `edge-out-top_body_v1_low`, `beam_end_v0_high`; letters, digits, `-` and `_` only
  (three's loader strips `.`, `:` and `/`). Edge, corner, roof and debris cases have one section (the placeholders
  name it `body`); beams and banisters have run sections. The kit record lists each case's sections and variants,
  or its alias.
- **Normals and maps.** Smooth round members, flat cut faces; fine detail as baked normals (texture layout §4).
  Report triangles, texture sizes and file size with every kit (the kit check's budget row).

The two placeholder kits made to this draft (engine test data, not game art; R5): **log** 22 pieces (13 cases with
meshes + 4 aliases), 757 triangles, GLB 58,404 B; **stone** 21 pieces (13 + 5 aliases), 490 triangles, GLB 47,320 B
(46c.16a: one mesh a piece, the low meshes gone); no textures (the runtime debug set); kit check 0 errors.

## 14. What is not here (moved by the 2026-11-04 review)

- **Retired:** pieces over flat faces (wall bodies, copings, plinths, mouldings, running boards, soffits, foundation
  skirts, opening frames, wall-thin), the per-role fallback cases, merged run sections for anything but beams and
  banisters. An opening's frame is now its walls' edges (jambs: vertical edges; lintel: bottom edges; sill: top edges).
- **47b (terrain tools and dressing):** the ground-contact fringe where a building meets terrain, and all ground
  scatter: the terrain material's runtime scatter rules (material id + the climate field).
- **46d (rendering and materials):** the material model and texture arrays, relief (tessellation / parallax) on faces
  near the camera, chamfered faces, kit instancing across chunks, the far field.
- **47a:** structure objects, rotated grids, door and window props in openings.

## 15. Known gaps (for the owner)

- **D500: shallow roofs.** A 1:2 roof (two cells along, one up) is not left to voxel faces as a whole: every other
  cell gets a plane, so it shows planes and steps alternating. Only 45° roofs are in scope; fixing it needs the passes
  to look one cell further.
- **D501: far roofs sit a little high.** At the middle and far rings a roof not aligned to the coarser grid sits up to
  1.5 coarse cells above the near roof's planes, and small roofs lose their slope at L2.
- **D504: a wall course under a window reads as a banister.** A one-cell wall row standing on a floor's edge under a
  window matches the kept banister-rail rule: it draws a rail, collides as a thin panel and gets no edge pieces. The
  beam/banister rules predate the edge model and need a sill rule.
- **D505: more pieces at the middle ring.** Every edge of a 1 m cell takes a low piece; since the coarse roofs are
  re-laid (R6b) the town's L1 lists 32.5 k instances (was 72.6 k) and draws 22.8 k (R9); whether L1 keeps only
  outer edges is question 5 in §16.
- **D508 (fixed in R6): a grey patch at hip apexes.** An even ridge's planes meet a cell above its voxels, where the
  shader read air; it now takes the cell under its eight.
- **D509: placeholder hidden faces.** The placeholder kits keep a few faces that never show (strip ends meeting
  unstaggered, the log kit's crossing stubs at corners). Real kits should close run ends with corner pieces only.

## 16. Open questions for the owner

1. **The case list.** Are these 21 cases the right start (10 edge/corner, 5 roof, 3 damage, 3 beam/banister)? Any
   to add now (a mixed-corner piece, a piece where two materials meet on an edge)?
2. **Required vs optional.** Outer edges and corners, ridge, eave, verge and hip required; inner edges and corners,
   valley and debris optional. Right?
3. **Ownership by material.** An edge takes the kit of one cell (outer: the solid one; inner: the one opposite the
   open cell). Is that right where a stone wall meets a timber floor (the floor's kit draws the inner edge)?
4. **Stagger.** 1/64–1/32 cell into the solid and ≤ 2° twist on edges and corners only: enough, too much? Stagger
   roof edges too?
5. **Middle ring pieces (D505).** Settled by the owner 2026-11-05: no pieces from L1 out (§11).
6. **Terrain contact.** No edge piece anywhere a building touches terrain (47b's fringe draws it). Confirm.
7. **Roofs.** 45° only, 90° hips/valleys only, everything else voxel faces. Enough for now, or 1:2 roofs (D500) soon?
8. **Roof collision as the drawn planes** (default chosen; plan-45 said "collide as ramps", the revision plan said
   "stays voxel"). Confirm the planes.
9. **Damage stages.** Two stages (8–14, 1–7) and near ring only. Enough? Should the edges round a damaged cell keep
   their pieces?
10. **Verge mirroring.** One verge mesh drawn mirrored on the second side, or a second case so a kit can carve the two
    sides differently?
11. **Mixed corners** (outer and inner edges meeting at one point) get no corner piece. Acceptable?
12. **Beams and banisters** keep their 10 window rules and run sections unchanged until the system is solid; D504
    (a sill read as a rail) needs a rule change. Fix now or with the beam/banister review?
13. **Case ids as the contract.** Once approved, kits name cases by these ids (kit format 1 stays a draft until then;
    old ids give "unknown case" errors). Agree?

## 17. What you are approving

- [ ] Roles are stored, pieces are read from the arrangement; construction shape = integrity (§1).
- [ ] Flat faces get no piece; pieces only on exposed lattice edges and corners, roof edges, damage, beams and
      banisters (§2–§3), with the solid/open, owner and no-piece rules of §3.
- [ ] The 21 cases of `edges-draft` v1 and their orientation convention (§4–§8).
- [ ] The roof mesher's 45° rule, its fallback to voxel faces, and roof collision as planes (§6).
- [ ] Damage display: two debris stages, debris faces, collision and light whole until air, near ring only (§7).
- [ ] Beams and banisters kept as built (§8).
- [ ] Aliases (24 rotations, never mirrored) and the engine-mirrored verge (§9); the stagger (§10).
- [ ] Pieces at L0 only; flat square voxels from L1 out; roof planes at every level (§11).
- [ ] Required / optional cases and the engine's fallbacks (§12); the Blender conventions (§13).
- [ ] What moved to 46d, 47a and 47b (§14).
- [ ] Your answers to §16.
