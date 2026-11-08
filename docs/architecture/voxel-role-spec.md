# Role spec — v1 CANDIDATE (edge model)

Status: **v1 CANDIDATE — awaiting the owner's look at acc46c-r2; nothing builds on it as final.** It is written to
the owner's acc46c-r answers (2026-11-05 and 2026-11-06, all 35) and the code built from them (46c.16a–f). It
freezes as v1 only after the full gate, the independent review and the owner's look at the acc46c-r2 pictures; until
then no Blender template, spec sheet, manual guide or art-factory request treats the case list as fixed. The page
matches the engine's edge catalogue `edges-draft` v3 (17 cases; `packages/voxel/src/kit-case-catalogue.ts`), and a
test (`tools/voxel-bench/role-spec-doc.test.ts`) fails when the page and the catalogue disagree on a case, its facts
or the numbers below. Sources: [plan 46c](../plan-phase-46c.md) §6c and the decision log (OWNER 2026-11-04, -05, -06
entries); [plan 45](../plan-phase-45.md) §1, §7 (owner 2026-11-02: the ten stored roles); the
[format spec](voxel-format-spec.md) §2.2 (the voxel value) and §3.7 (kits: edges, roofs, damage). The texture
layout is its own page: [voxel-trim-layout.md](voxel-trim-layout.md).

**How to read this page.** §1–§3 say what is stored, the one rule (no piece on a flat face) and who dresses a piece.
§4 explains the diagrams. §5–§7 list the 17 cases (edges and corners, roof edges, damage); each case is a kit
**slot** and opens with the same block of facts (generated from the engine), then a small diagram. §8–§11 are about
kits: slots, jitter, the near ring, decals. §12 is for kit artists (Blender). §13 says what is out of scope or moved,
§14 lists known gaps, §15 what approving this page means, §16 the defaults the owner has not confirmed yet.

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
| roof | 5 | construction | integrity | the roof mesher's planes where the cells form a 45° or 1:2 stair (§6), else voxel faces (a flat roof); roof-edge pieces |
| foundation | 6 | construction | integrity | plain voxel faces + edge pieces |
| stair | 7 | construction | integrity | plain voxel faces + edge pieces (a nosing is a top edge) |
| pillar | 8 | construction | integrity | plain voxel faces + edge pieces |
| opening | 9 | open | — | nothing: the gap a door or window prop fills (47a); the walls' edges round it are drawn **flush** (§3) |

**Construction differs from terrain and liquid in one way that matters here:** a construction cell is a whole
0.5 m block or nothing. Its shape field is not a fill but its **integrity** (owner 2026-11-04): 15 is intact, lower
values are the damage stages of §7, air is broken. Collision, navigation, occupancy and the level-of-detail
downsample treat a construction cell of any integrity as a whole block until it is air; light lets a damaged cell
through by its integrity (§7). Terrain and liquid keep shape as a fill. A smooth build stroke places whole blocks
(integrity 15), so damage is only ever written on purpose.

**Nobody paints a piece.** No role names an edge, a corner or a ridge, and nothing stores a case. The engine reads
them from the cells round each place, so building or digging one cell changes the pieces near it and nowhere else,
in the editor and in a running game alike.

## 2. The one rule: no piece on a flat face

Walls, floors, stairs, pillars, foundations and flat roofs are **plain voxel faces** with the material's tiling
texture (texture layout §2). **No piece is ever placed on a flat face.** Detail pieces go only **where faces meet**:

- on a **lattice edge** (the 0.5 m line where four cells meet) that the cells round it make exposed;
- on a **lattice corner** (the point where eight cells meet) the same way;
- on the edges of a **sloped roof's planes** (ridge, eave, verge, hip, valley);
- on the intact faces round a **damage hole** (§7).

Each piece is its own instance a 0.5 m edge or a corner: no merged run geometry, no hand-made lengths. Pieces are
drawn in the near ring only (level 0); from level 1 out the edges are plain square voxels (§10).

## 3. Solid, open, and who dresses a piece

**Solid and open.** Solid: any construction role, and terrain filled to its surface. Open: air, liquid, opening.

**Which case.** For a lattice edge the 4 cells round it decide: **1 solid = an outer edge, 3 = an inner edge, 2 side
by side = a flat face (no piece), 2 diagonal = two outer edges**, one a cell (never more than two pieces on one
edge). For a lattice corner the 8 cells decide: **1 solid = an outer corner, 7 = an inner corner.** Top / bottom /
vertical comes from gravity: a horizontal outer edge is a *top* edge when its solid cell is below it and a *bottom*
edge when it is above; an inner edge is *top* when its open cell is below (wall meets ceiling) and *bottom* when it is
above (wall meets floor). No vertical flip is ever applied to a case.

**Mixed corners use the corner slots** (owner A11). Where outer and inner edges meet at one point (a stair's notch,
an L wall's inside top corner, a wall's foot on a wider foundation), the engine sums the directions of the solid
cells round the point: fewer than five solid cells draw the **outer** corner slot, five or more the **inner** one,
turned to face the way the sum points; when the sum is 0 on an axis the shape does not say which way it faces and no
corner piece goes there. A stair notch and an L's inside top corner come out outer (3 solid), a wall corner on a
wider foundation inner (5). No slot of its own.

**The anchor.** Every piece sits on one cell, its **anchor**: an outer edge's or corner's one solid cell; an inner
one's cell diagonally opposite the open cell (a mixed corner's: the cell its summed direction names). A cell anchors
at most its own 12 edges and 8 corners. The anchor places the piece; who **dresses** it (whose kit draws it) is
decided next.

**Who dresses a piece** (owner A3, F1, F2, A6):

- **An edge piece belongs to the voxel it runs along**: an outer edge and a one-solid corner are dressed by their
  one solid cell.
- **Where cells meet** (an inner edge, an inner or mixed corner), the solid cells showing a face there compete by the
  **role order roof > wall > pillar > stair > floor > foundation**: a wall standing on a foundation dresses the corner
  at its foot in the wall's material; under a roof's overhang the roof's. A buried cell (no face at the place) never
  competes.
- **Two kits of the winning role at a corner or an inner edge: no piece.** Two walls of two kits meeting in an inside
  corner leave the cove bare; the shader's material blend draws the seam (owner F2). Two materials of one kit draw
  the same piece (a kit has one texture set, §8).
- **A dressing cell's material names the kit.** A material no kit binds draws no piece there.

**Where no piece goes:**

- **Terrain contact:** no piece on an edge or corner with a terrain cell of any fill round it (owner C1, A6): where a
  building meets the ground, the terrain material's dressing draws the contact (47b). For a building on its own
  grid the same rule needs the cross-grid contract (47a; not built).
- **Roof plane cells:** the roof mesher draws that surface and its own roof edges (§6).
- **A damage hole:** no edge piece round a cell shown as a hole (§7).
- **A buried cell**, and **a flat face** (§2).

**Openings: flush, never into the gap** (owner B7). An `opening` cell is open, so the jambs, lintel and sill round it
take the ordinary edge slots (a jamb is a vertical outer edge, a lintel a bottom edge, a sill a top edge), but drawn
**flush**: the instance names the anchor's faces toward the opening and the renderer draws the piece cut 1/128 cell
inside those faces, so nothing stands in the doorway or the window. An inner piece that would lie inside the
opening (a cove where the opening's floor meets a jamb) is not placed. A dug or broken hole is air, not an opening:
its edges are dressed as any other.

## 4. Reading the diagrams

Every case is written in **its own orientation**: the open side toward **+z** (the front); a vertical edge or a
corner opens toward **+x and +z**; up is **+y**; an edge runs along **x**. The engine turns it into place by a
**yaw** of 0–3 quarter turns about +y (each turn takes +x to +z). The diagrams are cuts of the cells round the place,
drawn from the rules of §3:

<!-- legend -->
| Symbol | Meaning |
|---|---|
| `#` | a solid cell (construction, or terrain for the counts; a piece never goes where terrain touches) |
| `.` | an open cell (air, liquid, opening) |
| `*` | the edge (seen end-on) or the corner the piece sits on |
| `O` | the piece's anchor cell (who dresses it: §3) |
| `R` | a roof cell; `r` a roof plane cell the roof mesher draws |
| `x` | a damaged cell shown as a hole; `f` an intact face toward it |
| `W` | a wall cell under or beside the roof |
| `G` `E` `g` `h` `v` | roof-edge pieces: ridge, eave, verge (gable edge), hip, valley |
<!-- /legend -->

A **cut across an edge** shows the 4 cells round a horizontal edge looking along x (back −z on the left, front +z on
the right, up on top). A **plan** (from above, x to the right, front +z down) shows the 4 cells round a vertical edge.
A **corner** is two plans, the layer above the corner and the layer below.

## 5. Edges and corners (10 cases)

Placed by the edge pass, which reads one cell round each cell. Pieces span the full 0.5 m of their edge; a corner
piece sits over the lattice point where its edges end. Mixed corners take the outer or inner corner slot (§3).

#### `edge-out-top` · slot

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** outer edge, the solid cell below it: a wall top, a stair nosing, a floor edge

A wall's top edge, a floor slab's edge, a stair's nosing.

```text
 cut across the edge (looking along x)
          back  front
   above   .  |  .
          ----*----
   below   O  |  .      O = # (the one solid cell, below the edge)
```

#### `edge-out-vertical` · slot

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** outer vertical edge: an outside wall corner, a jamb

An outside wall corner, a door or window jamb's edge.

```text
 plan (x →, front +z ↓), the vertical edge at *
          −x     +x
   back    O  |  .      O = # (the one solid cell)
          ----*----
   front   .  |  .
```

#### `edge-out-bottom` · slot

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** outer edge, the solid cell above it: a lintel underside, an overhang

A lintel's underside edge, an overhang, a floor's underside edge.

```text
 cut across the edge
          back  front
   above   O  |  .      O = # (the one solid cell, above the edge)
          ----*----
   below   .  |  .
```

#### `edge-in-top` · slot

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** inner edge, the open cell below it: wall meets ceiling

Where a wall meets the ceiling over it.

```text
 cut across the edge
          back  front
   above   O  |  #      the ceiling (O anchors it: diagonally opposite the open cell)
          ----*----
   below   #  |  .      the wall behind; the room in front
```

#### `edge-in-vertical` · slot

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** inner vertical edge: an inside wall corner

An inside wall corner.

```text
 plan, the vertical edge at *
          −x     +x
   back    O  |  #
          ----*----
   front   #  |  .      the open cell; O diagonally opposite it
```

#### `edge-in-bottom` · slot

- **Placed by:** the edge pass, one piece a 0.5 m lattice edge, yaw 0–3
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** inner edge, the open cell above it: wall meets floor, a riser foot

Where a wall meets the floor in front of it; a stair riser's foot.

```text
 cut across the edge
          back  front
   above   #  |  .      the wall behind; the room in front
          ----*----
   below   O  |  #      the floor (O anchors it: diagonally opposite the open cell)
```

#### `corner-out-top` · slot

- **Placed by:** the edge pass, one piece a lattice corner, yaw 0–3
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** outer corner, the solid cell below it: a box top corner

A box's top corner: where a top edge meets a vertical edge and another top edge.

```text
 layer above the corner      layer below
      −x   +x                   −x   +x
 back  .  .                 back O  .
 front .  .                 front .  .       one solid of 8: O, below and behind the corner *
```

#### `corner-out-bottom` · slot

- **Placed by:** the edge pass, one piece a lattice corner, yaw 0–3
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** outer corner, the solid cell above it: a box bottom corner

A box's bottom corner (an overhang's corner, a lintel's end underneath).

```text
 layer above the corner      layer below
      −x   +x                   −x   +x
 back  O  .                 back .  .
 front .  .                 front .  .       one solid of 8: O, above and behind
```

#### `corner-in-top` · slot

- **Placed by:** the edge pass, one piece a lattice corner, yaw 0–3
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** inner corner, the open cell below it

Where two walls and the ceiling meet in a room's corner (seven of eight solid, the open cell below).

```text
 layer above the corner      layer below
      −x   +x                   −x   +x
 back  O  #                 back #  #
 front #  #                 front #  .       the open cell below in front; O diagonally opposite
```

#### `corner-in-bottom` · slot

- **Placed by:** the edge pass, one piece a lattice corner, yaw 0–3
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** inner corner, the open cell above it

Where two walls and the floor meet in a room's corner (the open cell above).

```text
 layer above the corner      layer below
      −x   +x                   −x   +x
 back  #  #                 back O  #
 front #  .                 front #  #       the open cell above in front; O diagonally opposite
```

## 6. Roofs: the roof mesher and its roof edges (5 cases)

Three kinds of roof (owner A7): **flat, 45° and 1:2.** A flat roof is roof cells side by side: plain voxel faces with
edge pieces like a floor. A sloped roof is built from **roof cells laid as a 45° stair** (one cell up for one across)
**or a 1:2 stair** (two cells along, then one up; ≈ 26.6°; the build menu's 2 m and 4 m stair-step roofs). The stair
cells stay the data for light, occupancy and navigation. The **roof mesher** draws them, as the terrain mesher draws
terrain, as **flat sloped planes** with the roof material's tiling texture laid up the slope (texture layout §2):

- **Which cells.** A *plane cell* is a roof cell drawn whole (intact, cracked, or at an integrity its kit leaves out
  of every stage) with nothing solid above it that rises in at least one of
  the four horizontal directions. A cell is read at 45° first; it is read at 1:2 where it has no 45° reading, where
  the 45° reading was the flatter stair, or where a cell two along says 1:2 (each 1:2 cell is the low or the high
  cell of its pair: its phase). Roof cells are read two cells round.
- **One slope a roof** (default, owner to confirm): a cell's directions are all 45° or all 1:2; hips and valleys
  join equal slopes only, and a cell that would mix them keeps its voxel faces.
- **The fallback is voxel faces.** Flat roofs, plans other than 90° hips and valleys, and
  the few cells where the two ridges of a 1:2 L cross (D518) keep their voxel faces, so a roof never disappears.
- **The underside is always the parallel slope** one cell (0.5 m) below the top (owner C4), never voxel floors.
- **Wall tops: stepped, or filled where the roof's kit asks** (owner 2026-11-06: an artistic choice, default off).
  Without it the walls under a roof keep their stepped voxel tops under the parallel underside: a gable shows its
  steps with a small triangle open between each step and the slope, an eave wall stopping a cell under the roof
  leaves that cell open. With the roof kit's `wallTopFill` a wall (any body) directly under a plane cell, or under
  one air cell under it, has its top cut to that underside: the roof closes down onto it, so no voxel step shows
  inside the attic or outside under the eave and verge, and a gable's end wall follows the slope. A body two or more
  cells under the roof (an attic partition, a room's ceiling) is left as it is. A wall or chimney through the roof
  keeps its own faces. (47a's building object may override the fill per building.)
- **Wall and roof never blend** (owner 2026-11-06, D519). The roof planes show the roof's material up to the seam,
  the fill the wall's; walls and chimneys next to a roof show their own cells' materials, unblended.
- **Ridges, hips and a pyramid's apex** take the lower of two planes, valleys the higher.
- **Collision** follows the drawn planes at both slopes (a ramp; owner A8); light, occupancy and navigation keep the
  stair voxels.
- **Every level.** The mesher runs at every distance ring (a coarse level lays a 45° roof again at 45° and a 1:2
  roof at 1:2, over the walls it covers), so far roofs are planes; the roof-edge pieces, like every piece, are drawn
  in the near ring only (§10).

**Roof-edge pieces.** Pieces go along the planes' edges only: ridge, eave, verge (the gable edge), hip and valley;
no edge piece goes round a plane cell.

- **One mesh a roof-edge slot serves both slopes** (owner F3). Author it for 45°; on a 1:2 roof the engine pitches it
  onto the plane, placed per cell with the kit's jitter: an **eave** is turned rigidly about its line and a **verge**
  about the gable's normal through its middle (so it overlaps its neighbours by about 0.13 cell at each end on the
  shorter 1:2 run), a **ridge, hip or valley** is squashed to half its height about its line so both its sides lie on
  the shallower planes.
- **One verge mesh, drawn mirrored on the second side** (owner A10): author it rising toward **+x**; the engine draws
  the other side of the gable mirrored, its winding kept right.
- **Half pieces at hip apexes:** on an odd hip roof the apex cell's ridge and hips are drawn as half pieces (an
  instance flag; the kit authors no extra slot), so the ridge stops at the apex and the hip caps do not cross over.
- On an odd gable the ridge is centred on the middle cell (placed half a cell in and half a cell down).

```text
 cut across a gable roof (x →, up ↑), the planes drawn through the stair's outer corners
              G
            r/\r          G  roof-ridge: where the two planes meet
          r/ r  r\r       r  plane cells (their voxel faces are not drawn)
        r/ r    r  \r     E  roof-eave: the low edge of each plane, open below and in front
      E/ W        W  \E   W  the walls carrying the roof, their tops cut up to the parallel underside
       W              W
```

#### `roof-ridge` · slot

- **Placed by:** the roof mesher, on roof plane cells
- **Roles:** roof
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** the top line of two roof planes meeting

```text
 cut across the ridge
        G
      r/ \r        the ridge cap sits over the line the two planes meet on
    r/     \r
```

#### `roof-eave` · slot

- **Placed by:** the roof mesher, on roof plane cells
- **Roles:** roof
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** the lowest edge of a roof plane

```text
 cut across the eave (the plane rising toward −z in the case's own orientation)
     r\
       r\
         E        the lowest edge of the plane: open below and in front (+z)
```

#### `roof-gable` · slot

- **Placed by:** the roof mesher, on roof plane cells
- **Roles:** roof
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
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

#### `roof-hip` · slot

- **Placed by:** the roof mesher, on roof plane cells
- **Roles:** roof
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** an outside corner line of two roof planes

```text
 plan of a hip roof (x →, z ↓); h marks the hip lines (two planes meeting convex), G the ridge
   h . . . . . h
   . h . . . h .
   . . G G G . .
   . h . . . h .
   h . . . . . h
```

#### `roof-valley` · slot

- **Placed by:** the roof mesher, on roof plane cells
- **Roles:** roof
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** an inside corner line of two roof planes

```text
 plan of an L-shaped roof's inner corner; v marks the valley (two planes meeting concave)
   . . . . . .
   . . . . . .
   . . . v . .
   . . . . v .
   . . . . . v .
```

## 7. Damage: integrity and three stages (2 cases)

The engine has no "damage" value: a construction cell's shape is its integrity (owner 2026-11-04). What lowers it and
when is **game logic**; the engine only shows the state, by the **damage stage** of the cell's kit (owner A9 revised,
G1). The default split, which a kit may change in its `damage` field (each stage's integrity range, the pieces a face
for stages 2 and 3, a stage set to null is not used, an integrity in no stage draws intact; and its own crack image):

- **Integrity 15:** intact.
- **stage 1 (integrity 11–14): cracks.** The block is still drawn and keeps its edge pieces; its faces carry the crack
  overlay (the surface shader, both renderers; one engine crack map over the 4 × 4 m construction tile, laid on the
  grid as the base texture so neighbouring cracked cells show one pattern, which a kit may replace with its own image),
  stronger the lower the integrity within the stage. A cracked roof cell stays in its roof plane (the planes carry the
  crack), and a cracked wall under a roof keeps its top closed up to the underside.
- **stage 2 (integrity 6–10, 6 pieces a face): a hole.** The block is not drawn. The hole is no open air, so no edge
  piece goes round it; each intact neighbour face toward it is drawn and carries that many pieces of the neighbour's
  own kit's `damage-stage-2` slot, spread over the face.
- **stage 3 (integrity 1–5, 3 pieces a face): the same hole, fewer pieces** (`damage-stage-3`).
- **Air:** broken: the faces and edge pieces round the hole draw as for any hole.
- **The hole's kit decides the stage, the face's kit the pieces** (default, owner to confirm): a timber hole in a
  stone wall is a hole by timber's ranges, and the stone faces round it carry stone's pieces.
- **Only exposed damage shows.** A damaged cell with every face against solid stays a plain block.
- **Solid until air** (owner F4): collision and navigation keep the whole block at every stage. **Light** lets a
  damaged cell through by its integrity (its light coverage is integrity / 15, as a prop's coverage fraction; 46e
  reads it).
- **Near only.** A level-1 cell made of damaged cells counts as intact. Terrain has no damage (its shape is its fill).

#### `damage-stage-2` · slot

- **Placed by:** the damage rule, several a face, on an intact face opening toward a hole at stage 2
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** an intact face opening toward a hole at damage stage 2: many pieces scattered over it

```text
 a wall seen from the front; integrity 8 at x (stage 2)
   # # # # #
   # # f # #      x  not drawn (a hole, no edge pieces round it)
   # f x f #      f  intact faces toward it: face + 6 damage-stage-2 pieces spread over it
   # # f # #
```

#### `damage-stage-3` · slot

- **Placed by:** the damage rule, several a face, on an intact face opening toward a hole at stage 3
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** an intact face opening toward a hole at damage stage 3: fewer pieces scattered over it

```text
 the same wall; integrity 3 at x (stage 3)
   # # f # #
   # f x f #      x  not drawn; f: face + 3 damage-stage-3 pieces (nothing if the kit leaves the slot empty)
   # # f # #
```

## 8. Kits are slots

A kit belongs to a material type and draws the pieces of every cell whose material it binds (§3: the dressing
cell's). Every case of §5–§7 is a **slot**; the case id is the slot's stable name (owner A13). The kit record (kit
format 1, still a draft) holds `slots: {<case id>: {meshes: [{mesh, rotation?, weight?, mirror?}], gameData?}}` (a
mesh marked `mirror` is drawn mirrored across its case's run, winding and normal-map tangents flipped: one mesh for
both hands of a handed piece; owner 2026-11-06), the kit's `jitter` (§9), its `damage` stages (§7), an optional trim
layout (named, or its own `sheetLayout`: the trim layout page) and opaque game data.

- **Every slot is optional** (owner G2). An empty slot draws nothing: the place shows its plain square voxel edge (a
  damage slot left empty: the hole's faces stay plain). No other slot, kit or engine piece stands in, and the kit
  check never warns about an empty slot (it reports how many are filled). So an author can check the textures on
  plain voxels first and add pieces one slot at a time.
- **No engine default kit** (owner C11). A material no kit binds draws plain voxel faces and edges, no piece at all.
  A sample kit belongs in the authoring package (46c.17), never shipped or bound by default.
- **1..n meshes a slot**, each with a **rotation** (one of the 24 cube rotations, 0–23, fixed numbers in
  `cube-rotations.ts`) that turns it into the slot's own orientation, and a **weight** (absent 1). A rotation never
  mirrors, so normals and winding stay right; the verge's second side is the engine's own mirror (§6). Any mesh may
  fill any number of slots: one mesh may fill every slot. Two rotations do most of the work: rotation 5 (X90, a
  quarter turn about +x) turns a top edge under into a bottom edge; rotation 9 (ZM90, a quarter turn about −z) turns
  a horizontal edge up into a vertical one.
- **Which mesh draws** is picked from the slot's weighted meshes by a hash of the world cell, the piece and the
  **project seed** (the project setting `voxel_piece_seed`, 0 unless set; owner B7): a scene draws the same on every
  load, an edit elsewhere never reshuffles a piece, and a new seed rearranges the same meshes everywhere at once.
- **One texture set a kit** (owner B5): every piece of a kit uses the same one material (one trim sheet or one
  material), for batching; two are a kit-check error. Timber beams on stone, or granite and marble, are two kits; no
  per-slot material override.
- **Per slot game data** (break, sound, physics defaults) is opaque JSON passed through to the game; the engine never
  reads it.
- **Collision, navigation and light never read a piece.** They come from the voxels and the roof planes, so every kit
  of a material type plays the same.
- **Budgets** (triangles, textures, per mesh and in all) are reported by the kit check, never capped.

How the two placeholder kits fill their slots (engine test data, not game art; §12):

| Slot | Log placeholder | Stone placeholder |
|---|---|---|
| `edge-out-top` | own (round log, 2 meshes) | own (chamfered / chipped block edge, 2 meshes) |
| `edge-out-vertical` | own (log ends crossing a course) | edge-out-top's 2 meshes, rotation 9 |
| `edge-out-bottom` | edge-out-top's 2 meshes, rotation 5 | edge-out-top's 2 meshes, rotation 5 |
| `edge-in-bottom` | own (a pole in the corner) | own (fillet) |
| `edge-in-top` | edge-in-bottom's mesh, rotation 5 | edge-in-bottom's mesh, rotation 5 |
| `edge-in-vertical` | edge-in-bottom's mesh, rotation 9 | edge-in-bottom's mesh, rotation 9 |
| `corner-out-top` | own (crossing logs) | own (corner block) |
| `corner-out-bottom` | corner-out-top's mesh, rotation 5 | corner-out-top's mesh, rotation 5 |
| `corner-in-top`, `corner-in-bottom` | empty | empty |
| roof edges (5) | own: ridge log, eave fascia, barge log, hip and valley caps | own: ridge, hip and valley tiles, drip lip, verge board |
| `damage-stage-2`, `-3` | own: splinters (2), split log ends (2) | own: chips (2 each) |

So a kit can fill all ten edge and corner slots with **three meshes** (an outer edge, an inner edge, an outer
corner).

## 9. Stagger and jitter

Every piece (edges, corners, roof edges and damage pieces) is moved by a small amount hashed from its cell, so a row
of pieces reads hand-built, not machine-straight: **1/64–1/32 cell** (0.8–1.6 cm) **into the solid**, along the
bisector of its two faces (a roof edge into the roof, a damage piece into the cell it dresses), and twisted at most
**2°** about it (never more than the move hides). It never moves out of the faces, so no gap opens between a piece
and its faces. Each kit scales this by its own **jitter** (owner A4, C3): jitter 0–4 (default 1); 0 draws its pieces
exactly on the lattice, 2 moves and twists them twice as far. The hash reads the world cell, the project seed and
the piece's slot. Damage pieces are then spread over their face (a jittered √n × √n grid within ±0.3 cell, spun
about the face's normal). The stagger is drawing only: collision never sees it.

## 10. Detail rings: pieces at L0 only, rings per scene, quality level and runtime

**Two detail states** (owner 2026-11-05), as in the reference: **detail pieces in the near ring (level 0, 0.5 m
cells); plain flat square voxels from level 1 (1 m cells) out.** There is no low piece, so a kit authors **one mesh a
piece** and needs no LODs; collision comes from the voxels.

| Ring | Cells | Pieces | Surfaces |
|---|---|---|---|
| L0 (near) | 0.5 m | the kit's pieces (edges, corners, roof edges, damage) | voxel faces, roof planes |
| L1 (middle) and coarser | 1 m and up | **none** | flat square voxels, roof planes |

The piece ring **is** level 0's ring (default, owner to confirm). **Every ring is configurable** (owner 2026-11-05):

- **Per scene**, on its `voxelWorld` component, in metres: the load ring (`ring`: load and unload radius and height),
  the collision ring (`collision`), and the level rings (`levels`: `level0`, the piece ring; `level1`). Defaults: load
  192 m (unload 224 m), collision 48 m, level 0 64 m, level 1 128 m; level 0 stays at least the collision radius
  + 8 m. An indoor scene sets them small, a multi-km outdoor scene large.
- **Per quality level:** a scene's `quality` map gives a level a `scale` or its own distances; without it the quality
  level's `voxelRings` (0.25–4) scales every distance, or its tier's scale (√(tier budget / medium budget): low 0.71,
  medium 1, high 1.41), and the world takes that tier's stream memory budget.
- **At runtime:** scripts change them with `ctx.voxels.setRings(change | null)` (`ctx.voxels.rings()` reads them);
  the quality level applies on top. A change, or the quality level the page reports, applies without a reload: the
  streamer re-selects and swaps atomically.

The far field past the rings (no arbitrary draw cut-off, cheap stand-ins for km-distant ground) is 46d's.

## 11. Decals: the way to add dirt and moss

There is **no paint overlay layer** (owner B3 correction): the voxel value holds one material and a wetness, and the
shader blends only between neighbouring voxels' materials. **Dirt, moss, soot and stains are decals, and whole-voxel
material swaps**; the 9 reserved bits get no overlay meaning. Both decal kinds reach voxel worlds in the Scene view,
Play and an export, on both renderers:

- **projected decals** mark voxel faces at every level and the kit pieces;
- **clipped decals** are cut from level-0 chunks (default, owner to confirm: coarser levels change the surface with
  distance), cut again when a dig changes the surface under them; kit pieces take projected marks only;
- `voxelWorld.decalLayers` sets which decal layers mark the world's faces and pieces.


## 12. Building a piece in Blender

These match what the engine draws, the kit check tests and `tools/voxel-bench/kits/make_placeholder_kits.py` writes:

- **Units and pivot.** Metres. The object's origin is the **centre of the anchor cell**; the cell is −0.25 … +0.25 m
  on each axis. A piece must touch its cell (else an error: it draws beside it) and may reach half a cell past it
  (±0.5 m; roof-edge pieces a cell higher, since the planes run up to a cell above the voxel); past that a warning.
  Apply rotation and scale; leave the object at the origin.
- **Axes in the case's own orientation** (glTF, +y up): the open side (what shows) toward **+z**, the edge along
  **+x**, up **+y**; a vertical edge runs up +y and opens toward +x and +z. In Blender (Z up; the glTF exporter turns
  it): open side toward **−Y** (the Front view), the edge along **+X**, up **+Z**. The voxel body is behind, toward
  Blender +Y.
- **No hidden geometry.** Leave out faces that lie against the voxel body or under a roof plane. Pieces sit over the
  voxel's square edge (it is not chamfered), standing at most a few centimetres proud of the faces; the stagger moves
  them inward up to 1.6 cm at jitter 1, so a piece that stands less proud than that can sink under its faces in places
  (the stone placeholder's edge stands 3.5 cm proud).
- **Roof pieces** follow the roof mesher's 45° planes (the engine pitches them onto 1:2 roofs, §6): the verge rising
  toward +x, the ridge written for the cell's high side (the engine centres it on odd roofs), the eave open toward +z
  with its plane rising toward −z, the hip and valley running from the cell's +x +z corner (low) up to its −x −z
  corner. Leave room for the 1:2 pitch: a verge overlaps its neighbours there, a ridge is squashed to half height.
- **Damage pieces** are one fragment each, centred on the face toward the hole; the engine places several a face.
- **Names.** One GLB a kit (or several), one node a mesh, all at the file's origin; a slot names its meshes by asset
  and node, so names are free. The placeholders use `<case>_v<k>`, e.g. `edge-out-top_v0`; letters, digits, `-` and
  `_` only (three's loader strips `.`, `:` and `/`).
- **One material for the whole kit** (§8). Smooth round members, flat cut faces; fine detail as baked normals
  (texture layout §3). Report triangles, texture sizes and file size with every kit (the kit check's budget row);
  no LODs (pieces draw at L0 only).

**The two placeholder kits** (46c.16e, unchanged since; kit check 0 errors, 0 warnings, trim T1–T7 ok): **log** 14
meshes filling 15 of 17 slots, 304 triangles (404 counting each slot's meshes), GLB 26,748 B, record 4,569 B;
**stone** 13 meshes filling 15 slots, 170 triangles (264), GLB 19,956 B, record 4,834 B; the inner corners left
empty; no textures (the runtime debug set), no LODs, collision from the voxels.

## 13. Out of scope, and what moved

- **Beams and banisters are out of the voxel phases** (owner A1, A12): their cells are plain voxels with edge pieces
  like any other construction cell; the catalogue has no window rules and no per-role fallback case. More cases come
  later, when a game needs them.
- **Retired:** pieces over flat faces (wall bodies, copings, plinths, mouldings, running boards, soffits, foundation
  skirts, opening frames), merged run sections, low pieces, the required / optional split, stand-ins, aliases (now a
  slot mesh with a rotation), debris pieces in a damaged cell's place, and the engine default kit.
- **46d (rendering and materials):** the material model and texture arrays, a material's height depth, wetness
  beyond darkening, the near-ring tessellation spike (its first item) and relief on faces near the camera, kit
  instancing across chunks, the far field.
- **47a:** structure objects and rotated grids, door and window props in openings. **Owner requirement not met yet
  (A6):** a building on its own grid places no pieces where it meets terrain; that needs the cross-grid contract
  (spec §3.6 gap M7), so in 46c only buildings on the world's grid follow it.
- **47b (terrain tools and dressing):** the ground-contact fringe where a building meets terrain, all ground scatter
  (the terrain material's rules: material id + the climate field), and building footprints masking scatter (owner
  A6). The kit slot panel (drag and drop) is 47; slots are assigned through the kit command now.

## 14. Known gaps (open D-rows)

- **D518:** where the two ridges of a 1:2 L hip roof cross, up to four cells keep their voxel faces.
- **D519:** a wall cut up to a roof's underside reads the roof's material where wall and roof differ (the shader
  picks materials by position); 46d's material model.
- **D520:** a flat roof laid one cell above a wall's top with an air gap loses the wall's top-edge pieces there.
- **D515:** an L hip roof with arms of odd and even coarse width keeps one to three voxel steps at level 1 or 2.
- **D516:** at the load ring's edge whole chunk columns come and go, so a house the edge cuts can show a floating
  overhang.
- **D509:** the placeholder kits keep a few hidden faces (test data; real kits close run ends with corner pieces).
- **D502:** the roof mesher is over the 0.1–0.2 ms section budget at p95 (recorded for the performance phase).

## 15. What you are approving

- [ ] Roles are stored, pieces are read from the arrangement; construction shape = integrity (§1).
- [ ] No piece on a flat face; pieces only on exposed lattice edges and corners, roof edges and the faces round a
      damage hole (§2).
- [ ] The case rules, mixed corners through the corner slots, the anchor, and who dresses a piece: role order roof >
      wall > pillar > stair > floor > foundation, two kits at a corner or inner edge → none, terrain contact → none;
      flush pieces at `opening` cells (§3).
- [ ] The 17 cases of `edges-draft` v3 as slots, and their orientation convention (§4–§7).
- [ ] Roofs: flat, 45° and 1:2, one slope a roof, voxel faces as the fallback, the parallel underside, wall tops
      stepped or filled up to it by the roof kit's choice, no blend across the seam, collision as the planes; one roof-edge mesh pitched for both slopes, the mirrored verge, half
      pieces at hip apexes (§6).
- [ ] Damage: three stages a kit (ranges, piece counts, crack texture), solid until air, light by integrity, near
      ring only (§7).
- [ ] Kits as slots: all optional, 1..n meshes with a rotation and a weight, the project seed, one texture set a
      kit, no engine default kit (§8); per-kit jitter on every piece, into the solid (§9).
- [ ] Pieces at L0 only, plain voxels from L1; every ring per scene, per quality level and at runtime (§10).
- [ ] Decals as the way to add dirt and moss; no paint overlay layer (§11).
- [ ] The Blender conventions (§12); beams and banisters out of scope, and what moved to 46d, 47a and 47b (§13).

## 16. Defaults to confirm

Every "default chosen, owner to confirm" of the build items 46c.16a–f (plan 46c decision log), one line each:

1. One slope a roof: no mixed 45° / 1:2 on one roof; a cell that would mix keeps its voxel faces (batch 4, 16d).
2. The detail-piece ring is level 0's ring; no ring of full-detail voxels without pieces inside it (16a).
3. A quality tier scales every ring by √(its budget / the medium budget): low 0.71, medium 1, high 1.41 (16a).
4. A script changes the scene's base distances; the quality level applies on top, a scene's own per-level distance
   wins (16a).
5. Jitter is one number a kit (0–4, a scale of the engine stagger), not separate move and twist values (16b).
6. The project seed is the project setting `voxel_piece_seed` (0 unless set) (16b).
7. A slot mesh has a rotation but no mirror of its own; the engine mirrors only the second verge (16b).
8. "One texture set" = every drawn primitive names the same material, same images by CRC-32 (16b).
9. A damaged cell whose kit has no damage piece (or no kit) still shows as a hole with its neighbours' faces (16b,
   kept by 16e's stages).
10. "Two materials" at a corner means two kits; two materials of one kit draw the same piece (16c).
11. Two kits of one role leave inner edges bare too, not only corners (16c).
12. Only cells showing a face at the place compete for it; a buried cell's role never decides (16c).
13. Mixed corner: fewer than five solid cells → outer corner slot, five or more → inner, none when the summed
    direction is 0 on an axis (16c).
14. Flush = a copy of the mesh cut 1/128 cell inside the faces toward the opening; an inner piece in an opening is
    not placed (16c).
15. The instance grows to 12 bytes for the dressing word (16c).
16. A 45° roof cell reads exactly as before; 1:2 only where there is no 45° reading or evidence says 1:2 (16d).
17. Pitching one roof-edge mesh: eaves and verges turned rigidly, ridges, hips and valleys squashed to half height
    (16d).
18. "Walls under a roof" = a body directly under a plane cell or under one air cell under it (16d).
19. The hole's kit decides the stage, the face's kit the damage pieces (16e).
20. Default damage counts 6 (stage 2) and 3 (stage 3) pieces a face, at most 16, one fragment a slot spread by the
    engine (16e).
21. Crack strength rides in the face's vertices: cracks on voxel faces and roof planes (a cracked roof cell stays in its plane), not on edge pieces (16e, 16h).
22. One generated engine crack map (512² over the 4 × 4 m construction tile, laid on the grid as the base texture, so neighbouring cracked cells show one pattern), replaceable by a kit's image of the same tile (16e, 16k).
23. Light coverage = integrity / 15 for every damaged construction cell, buried or not (16e).
24. Clipped decals are cut from level-0 chunks only; kit pieces take projected decals only (16f).
25. `decalLayers` is one mask on the `voxelWorld` object for faces and pieces (16f).
26. The Scene view and the slice page keep the scene's own distances (no quality level there); Play and exports
    follow the level the page draws at (16a).
