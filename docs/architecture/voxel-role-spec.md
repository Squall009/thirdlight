# Role spec — DRAFT — v1 candidate (edge model)

Status: **DRAFT — awaiting owner approval (46c hard stop); nothing builds on it as final.** No kit pipeline, Blender
template, spec sheet, manual guide or art-factory request treats this case list as fixed until the owner approves it.
The owner's 2026-11-04 review of the first draft (46 cases, pieces over flat walls) replaced it with this edge model;
the earlier text is in git history. This page is written from the engine's edge catalogue `edges-draft` v2 (18 cases;
`packages/voxel/src/kit-case-catalogue.ts`), and a test (`tools/voxel-bench/role-spec-doc.test.ts`) fails when this
page and the catalogue disagree on a case or its facts. Sources: [plan 46c](../plan-phase-46c.md) §6b and the decision
log (OWNER 2026-11-04 entries, R1–R5 results); [plan 45](../plan-phase-45.md) §1, §7 (owner 2026-11-02: the ten stored
roles); the [format spec](voxel-format-spec.md) §2.2 (the voxel value) and §3.7. The texture layout is its own draft:
[voxel-trim-layout.md](voxel-trim-layout.md).

**How to read this page.** §1–§3 say what is stored and the one rule (flat faces get no piece). §4 explains the
diagrams. §5–§7 list the 18 cases: edges and corners, roof edges, damage; each case is a kit **slot** and has the
same block of facts (generated from the engine) followed by a small diagram; §8 says where beams and banisters went.
§9–§13 are for kit artists: one mesh for several slots, stagger and jitter, detail levels, how a kit fills its slots,
Blender conventions. §14 says what moved to other
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

**Nobody paints a piece.** No role names an edge, a corner or a ridge. The engine reads them from
the cells round each place, so building or digging one cell changes the pieces near it and nowhere else, in the editor
and in a running game alike. Nothing stores a case.

## 2. The one rule: flat faces get no piece

Walls, floors, stairs, pillars, foundations and flat roofs are **plain voxel faces** with the material's tiling
texture (texture layout §2). No piece is ever placed on a flat face. Detail pieces go only **where faces meet**:

- on a **lattice edge** (the 0.5 m line where four cells meet) that the cells round it make exposed;
- on a **lattice corner** (the point where eight cells meet) the same way;
- on the edges of a **roof's planes** (ridge, eave, verge, hip, valley);
- on a **damaged** cell and on the faces opening toward it.

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
  a debris cell (§7); on a buried cell.

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
| `W` | a wall cell under or beside the roof |
| `G` `E` `g` `h` `v` | roof-edge pieces: ridge, eave, verge (gable edge), hip, valley |
<!-- /legend -->

A **cut across an edge** shows the 4 cells round a horizontal edge looking along x (back −z on the left, front +z on
the right, up on top). A **plan** (from above, x to the right, front +z down) shows the 4 cells round a vertical edge.
A **corner** is two plans, the layer above the corner and the layer below.

## 5. Edges and corners (10 cases)

Placed by the edge pass, which reads one cell round each cell. One case a slot; a cell owns at most its 12 edges and
8 corners. Pieces span the full 0.5 m of their edge; a corner piece sits over the lattice point where its edges end.

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
   above   O  |  #      the ceiling (O owns it: diagonally opposite the open cell)
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
   below   O  |  #      the floor (O owns it: diagonally opposite the open cell)
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

A sloped roof is built from **roof cells laid as a 45° stair or a 1:2 stair** (two cells along, then one up; the
build menu's 2 m and 4 m stair-step roofs). The stair cells stay the data for light, occupancy and navigation. The
**roof mesher** draws them, like the terrain mesher draws terrain, as **flat sloped planes** with the roof material's
tiling texture, mapped up the slope (its 4 × 4 m tile follows the slope at both pitches):

- **Which cells.** A *plane cell* is an intact roof cell with nothing solid above it that rises in at least one of the
  four horizontal directions: at **45°** a roof cell one up and one across, or one down and one across the other way;
  at **1:2** the cells two along each way fit a stair of two cells a level, the cell being its pair's low or high cell
  (its phase). **One slope a roof**: hips and valleys join equal slopes only (default chosen, owner to confirm).
  Flat roofs and damaged roof cells are left out (a hole, §7), and so are the few cells where the two ridges of a 1:2
  L cross (D518). **Every cell left out keeps its voxel faces** (the fallback), so a roof never disappears.
- **The surface.** The top runs through the stair's outer corners; the underside is always the parallel plane one
  cell (0.5 m) lower. A wall (any body) directly under a roof cell, or one air cell under it, has its top cut to that
  underside: the roof closes down onto it, so no voxel step shows inside the attic or outside under the verge and
  eave, and a gable's end wall follows the slope. Ridges, hips and a pyramid's apex take the lower of two planes,
  valleys the higher. Planes stop at a non-roof neighbour: a wall or chimney through the roof keeps its faces.
- **Only 90° hips and valleys in plan.** Other plans keep voxel faces.
- **Collision** follows the drawn planes at both slopes (a ramp; owner A8); light, occupancy and navigation keep the
  stair voxels.
- **Every level.** The mesher runs at every distance ring (planes read better than stairs far away; a coarse level
  lays a 45° roof again at 45° and a 1:2 roof at 1:2); the roof-edge pieces, like all pieces, only near (§11).
- **One mesh a roof-edge slot serves both slopes** (owner F3): author it for 45° as below; on a 1:2 roof the engine
  pitches it onto the plane, placed per cell with the kit's jitter: an eave or a verge turned rigidly (a verge then
  overlaps its neighbours a little on the shorter 1:2 run), a ridge, hip or valley squashed to half its height so
  both its sides lie on the shallower planes.
- **No edge pieces round plane cells**: the roof's own edges below take their place. Roof-edge pieces are staggered
  like every piece (§10).

```text
 cut across a gable roof (x →, up ↑), the planes drawn through the stair's outer corners
              G
            r/\r          G  roof-ridge: where the two planes meet (one cell owns it; on an odd roof it is
          r/ r  r\r          centred on the middle cell, placed half a cell in and half a cell down)
        r/ r    r  \r     r  plane cells (their voxel faces are not drawn)
      E/ W        W  \E   E  roof-eave: the low edge of each plane, open below and in front
       W              W   W  the walls carrying the roof
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

## 7. Damage: integrity and debris (3 cases)

The engine has no "damage" value: a construction cell's shape is its integrity (owner 2026-11-04). What lowers it and
when is **game logic**; the engine only shows the state.

- **Integrity 15:** intact. **8–14:** the `debris` slot. **1–7:** the `debris-heavy` slot (a kit may put the same mesh
  in both; an empty slot draws nothing, so the cell shows as a hole rimmed by its neighbours' faces). **Air:** broken:
  no debris; the faces and edge pieces round the hole draw as for any hole.
- **Only exposed damage shows.** A damaged cell with every face against solid stays a plain block (nothing hidden
  inside a mass).
- **The damaged cell's faces are left to its debris piece**; every intact face that opens toward it draws its face
  plus a `debris-face` piece (a broken rim), owned by the intact cell (its material's kit). Edges round a debris cell
  take no edge piece.
- **Collision, light, occupancy and navigation keep the cell whole until it is air** (owner).
- **Near only.** A level-1 cell made of damaged cells counts as intact, so damage shows in the nearest ring only.

#### `debris` · slot

- **Placed by:** the debris rule, on an exposed damaged construction cell, in place of its faces
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** a damaged cell, integrity 8–14: drawn by this piece in place of its faces

```text
 a wall seen from the front; integrity 12 at x
   # # # # #
   # # f # #      x  drawn by the debris piece (integrity 8–14), its own faces left out
   # f x f #      f  intact faces toward it: face + debris-face piece
   # # f # #
```

#### `debris-heavy` · slot

- **Placed by:** the debris rule, on an exposed damaged construction cell, in place of its faces
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** a badly damaged cell, integrity below 8: drawn by this piece in place of its faces

```text
 the same wall; integrity 5 at x
   # # f # #
   # f x f #      x  drawn by the debris-heavy slot (integrity below 8); nothing if the kit leaves it empty
   # # f # #
```

#### `debris-face` · slot

- **Placed by:** the debris rule, on an intact face opening toward a damaged cell
- **Roles:** every construction role
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Stagger:** into the solid, scaled by the kit's jitter
- **Catalogue note:** an intact face opening toward a damaged cell: its broken edge

```text
 cut through the wall at the damaged cell (front +z →)
   #  #  #
   #  f| x       the intact cell's face toward x carries a debris-face piece (placed by yaw, or tipped
   #  #  #       face-up / face-down for faces above or below the damage)
```

## 8. Beams and banisters: not in the voxel phases

Beams and banisters, which an earlier draft read from the arrangement with window rules and run sections, are out of
the voxel phases (owner 2026-11-06). Their cells are plain voxels with edge pieces like any other construction cell;
the catalogue has no window rules and no per-role fallback case.

## 9. One mesh, many slots (rotations and the verge mirror)

Many cases are the same shape turned. A slot lists one or more **meshes**, each with an optional **rotation** (one
of the 24 cube rotations, 0–23; rotation numbers are fixed, `cube-rotations.ts`) that turns it into the slot's own
orientation, and an optional weight. Any mesh may fill any number of slots: one mesh may fill every slot. A rotation
never mirrors, so normals and winding stay right. Two do most of the work: rotation 5 (X90, a quarter turn about
+x) turns a top edge under into a bottom edge; rotation 9 (ZM90, a quarter turn about −z) turns a horizontal edge up
into a vertical one.

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

So a kit can fill all ten edge and corner slots with **three meshes** (an outer edge, an inner edge, an outer
corner). The **verge** is different: its two sides are mirror images, which no rotation gives, so the engine draws the
second side mirrored by itself (§6) and the kit authors one verge rising toward +x.

## 10. Stagger

Every piece (edges, corners, roof edges and damage) is moved by a small amount hashed from its cell, so a row of edge
pieces reads hand-built, not machine-straight: **1/64–1/32 cell** (0.8–1.6 cm) **into the solid**, along the bisector
of its two faces (a roof edge into the roof, a debris piece into its cell), and twisted at most **2°** about it (never
more than the move hides). It never moves out of the faces, so no gap opens between a piece and its faces. Each kit
scales this by its own **jitter**: jitter 0–4 (default 1); 0 draws its pieces exactly on the lattice, 2 moves and
twists them twice as far. The hash reads the world cell, the level, the project's **piece seed** (the
`voxel_piece_seed` project setting) and the piece's slot: an edit elsewhere never moves a piece, and a new seed
reshuffles the whole world at once.

**Several meshes in a slot** work the same way: a slot may list several weighted meshes (two log diameters, two block
chips); which one draws is hashed from the world cell, the piece seed and which of the cell's pieces it is, so the
edges of one cell vary on their own and nothing reshuffles when you build elsewhere.

## 11. Detail levels: pieces near, plain voxels from the middle ring out

Owner 2026-11-05: two states only, as in the reference — **detail pieces near, flat square voxel edges from the
middle distance outward.** There is no "simple piece" stage, so a kit authors **one mesh per piece** (no low version).

| Ring | Cells | Pieces | Surfaces |
|---|---|---|---|
| L0 (near) | 0.5 m | the kit's pieces (edges, corners, roof edges, debris) | voxel faces, roof planes |
| L1 (middle) and coarser | 1 m and up | **none** | flat square voxels, roof planes |

Damage shows at L0 only (§7). The far field (no draw cut-off, cheap stand-ins for km-distant terrain) is 46d's.
*Built so in 46c.16a (derived 21): level 1 and coarser list no pieces; the `low` mesh left the kit format, the kit
check and the placeholder kits.*

## 12. How a kit fills its slots, and what the engine does without it

A kit belongs to a material type and draws the pieces of every cell whose material it binds. Its record (kit format
1, a DRAFT) maps case ids to **slots**: `slots: {<case id>: {meshes: [{mesh, rotation?, weight?}], gameData?}}`, with
the kit's `jitter` (§10), its trim layout and opaque game data beside them.

- **Every slot is optional.** There is no required / optional split: a kit fills the slots it wants and the kit
  check reports how many it fills (info, never a warning). **An empty slot draws nothing**: the place shows its plain
  square voxel edge (a debris cell: a hole, §7). No other slot, kit or engine piece stands in.
- **No engine default kit.** A material no kit binds draws plain voxel faces and edges, with no pieces at all.
- **Per slot:** one or more meshes (drawn at L0 only), each with a cube rotation and a weight, and opaque game data
  (break, sound, … passed through to the game; the engine never reads it).
- **One texture set a kit** (one trim sheet or one material for every mesh, so the kit batches); two are a kit-check
  error.
- **Collision, navigation and light never read a piece.** They come from the voxels (and the roof planes).
- **Budgets** are reported by the kit check (triangles and textures per mesh and in all), never capped.

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
- **Names.** One GLB a kit, one node a mesh, all at the file's origin; a slot names its meshes by asset and node, so
  names are free. The placeholders use `<case>_v<k>`, e.g. `edge-out-top_v0`, `edge-out-top_v1`; letters, digits,
  `-` and `_` only (three's loader strips `.`, `:` and `/`).
- **Normals and maps.** Smooth round members, flat cut faces; fine detail as baked normals (texture layout §4).
  Report triangles, texture sizes and file size with every kit (the kit check's budget row).

The two placeholder kits made to this draft (engine test data, not game art; R5), in the slot format: **log** 13
meshes filling 16 of 18 slots, 391 triangles, GLB 33,144 B; **stone** 12 meshes filling 16 slots, 286 triangles, GLB
27,812 B; the inner corners left empty; no textures (the runtime debug set).

## 14. What is not here (moved by the 2026-11-04 review)

- **Retired:** pieces over flat faces (wall bodies, copings, plinths, mouldings, running boards, soffits, foundation
  skirts, opening frames, wall-thin), the per-role fallback cases, merged run sections, the required / optional split,
  stand-ins, aliases (now a slot mesh with a rotation) and the engine default kit. Beams and banisters are out of the
  voxel phases (§8). An opening's frame is now its walls' edges (jambs: vertical edges; lintel: bottom edges; sill:
  top edges).
- **47b (terrain tools and dressing):** the ground-contact fringe where a building meets terrain, and all ground
  scatter: the terrain material's runtime scatter rules (material id + the climate field).
- **46d (rendering and materials):** the material model and texture arrays, relief (tessellation / parallax) on faces
  near the camera, chamfered faces, kit instancing across chunks, the far field.
- **47a:** structure objects, rotated grids, door and window props in openings.

## 15. Known gaps (for the owner)

- **D500 (fixed in 46c.16d): shallow roofs.** 1:2 roofs are planes like 45° ones (§6).
- **D518: where a 1:2 L's ridges cross** up to four cells keep their voxel faces (each arm flattens the other's
  stair), and at a coarse level where the arms are four cells wide a cell or two read 45°.
- **D519: a cut wall top takes the roof's material.** The surface shader picks materials by position from the cells,
  so the part of a wall cut up to the roof's underside, which lies in the roof cell's space, reads the roof's material
  where wall and roof differ: the material line still steps (the geometry does not). 46d's material model.
- **D501: far roofs sit a little high.** At the middle and far rings a roof not aligned to the coarser grid sits up to
  1.5 coarse cells above the near roof's planes, and small roofs lose their slope at L2.
- **D504 (gone with the window rules):** a wall course under a window no longer reads as a banister; it is plain
  voxels with edge pieces.
- **D505: more pieces at the middle ring.** Every edge of a 1 m cell takes a low piece; since the coarse roofs are
  re-laid (R6b) the town's L1 lists 32.5 k instances (was 72.6 k) and draws 22.8 k (R9); whether L1 keeps only
  outer edges is question 5 in §16.
- **D508 (fixed in R6): a grey patch at hip apexes.** An even ridge's planes meet a cell above its voxels, where the
  shader read air; it now takes the cell under its eight.
- **D509: placeholder hidden faces.** The placeholder kits keep a few faces that never show (strip ends meeting
  unstaggered, the log kit's crossing stubs at corners). Real kits should close run ends with corner pieces only.

## 16. Open questions for the owner

1. **The case list.** Are these 18 cases the right start (10 edge/corner, 5 roof, 3 damage)? Any to add now (a
   mixed-corner piece, a piece where two materials meet on an edge)?
2. **Required vs optional.** Settled by the owner: every slot is optional; an empty slot draws nothing (§12).
3. **Ownership by material.** An edge takes the kit of one cell (outer: the solid one; inner: the one opposite the
   open cell). Is that right where a stone wall meets a timber floor (the floor's kit draws the inner edge)?
4. **Stagger.** 1/64–1/32 cell into the solid and ≤ 2° twist on every piece, scaled by the kit's jitter: enough, too
   much?
5. **Middle ring pieces (D505).** Settled by the owner 2026-11-05: no pieces from L1 out (§11).
6. **Terrain contact.** No edge piece anywhere a building touches terrain (47b's fringe draws it). Confirm.
7. **Roofs.** Answered (A7, F3, C4): flat, 45° and 1:2; one roof-edge mesh pitched; the underside parallel, walls
   under a roof cut to it. Open: one slope a roof (no mixed slopes; default chosen, owner to confirm).
8. **Roof collision as the drawn planes:** confirmed (A8), at both slopes.
9. **Damage stages.** Two stages (8–14, 1–7) and near ring only. Enough? Should the edges round a damaged cell keep
   their pieces?
10. **Verge mirroring.** One verge mesh drawn mirrored on the second side, or a second case so a kit can carve the two
    sides differently?
11. **Mixed corners** (outer and inner edges meeting at one point) get no corner piece. Acceptable?
12. **Beams and banisters.** Settled by the owner: out of the voxel phases (§8).
13. **Case ids as the contract.** Once approved, kits name cases by these ids (kit format 1 stays a draft until then;
    old ids give "unknown case" errors). Agree?

## 17. What you are approving

- [ ] Roles are stored, pieces are read from the arrangement; construction shape = integrity (§1).
- [ ] Flat faces get no piece; pieces only on exposed lattice edges and corners, roof edges and damage (§2–§3),
      with the solid/open, owner and no-piece rules of §3.
- [ ] The 18 cases of `edges-draft` v2 and their orientation convention (§4–§7).
- [ ] The roof mesher's 45° rule, its fallback to voxel faces, and roof collision as planes (§6).
- [ ] Damage display: two debris stages, debris faces, collision and light whole until air, near ring only (§7).
- [ ] Beams and banisters out of the voxel phases (§8).
- [ ] Slot meshes with a cube rotation (24, never mirrored) and the engine-mirrored verge (§9); the stagger and
      per-kit jitter on every piece (§10).
- [ ] Pieces at L0 only; flat square voxels from L1 out; roof planes at every level (§11).
- [ ] Every slot optional, an empty slot draws nothing, no engine default kit (§12); the Blender conventions (§13).
- [ ] What moved to 46d, 47a and 47b (§14).
- [ ] Your answers to §16.
