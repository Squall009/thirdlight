# Role spec — DRAFT — not v1 (v1 candidate)

Status: **DRAFT — awaiting owner approval (46c hard stop); nothing builds on it as final.** No kit pipeline, Blender
template, spec sheet, manual guide or art-factory request treats this case list as fixed until the owner approves it.
It is written from the engine's draft case catalogue `cases-draft` v4 (46 cases; `packages/voxel/src/kit-case-catalogue.ts`),
and a test (`tools/voxel-bench/role-spec-doc.test.ts`) fails when this page and the catalogue disagree on a case, its
marking, its facts or its rule diagrams. Sources: [plan 45](../plan-phase-45.md) §1 (the role spec, slopes by role,
roof kits, foundation skirts), §7 owner 2026-11-02 (the ten stored roles; beams, banisters and soffits inferred), §7a
(inferred architecture, merge-compatible sections, high/low then voxel fallback); [plan 46c](../plan-phase-46c.md)
(46c.2–46c.10 results and decision log); the [format spec](voxel-format-spec.md) §2.2 (the voxel value). The trim
layout for detail pieces is its own draft: [voxel-trim-layout.md](voxel-trim-layout.md).

**How to read this page.** §1–§4 explain the vocabulary once (roles, the neighbourhood the engine looks at, how a
case is drawn). §5–§13 go role by role: what each role is for, its cases, and what a kit must make for it. Every case
has the same block: its marking, its facts, and one diagram per rule that picks it. §14–§17 are for kit artists
(levels, variants and mirroring, how to build a piece in Blender). §18 lists what is known not to work yet, §19 the
questions only you can answer, §20 what approving this page means.

## 1. Stored roles and inferred features

A voxel stores four things (format spec §2.2): a material, a **role**, a shape (how full it is) and a wetness. The
role is 4 bits, so there are at most 16 roles; ten are assigned (owner 2026-11-02), the rest are refused until a
later spec assigns them (add-only).

| Role | Value | What it is | Has cases |
|---|---|---|---|
| air | 0 | empty space | no |
| terrain | 1 | ground: earth, rock, sand; drawn as a smooth surface by the terrain rules (46b), never by kit pieces | no |
| liquid | 2 | water and other liquids (a later phase) | no |
| wall | 3 | upright construction | yes (§6) |
| floor | 4 | horizontal construction you stand on or under | yes (§7) |
| roof | 5 | the roof's stepped 45° pattern and flat roofs | yes (§8) |
| foundation | 6 | the base a building stands on, meeting the terrain | yes (§9) |
| stair | 7 | the stepped 45° pattern you walk up | yes (§10) |
| pillar | 8 | a free-standing column | yes (§11) |
| opening | 9 | a gap a door or window will fill (the props are 47a's) | yes (§12) |
| — | 10–15 | unassigned (refused) | — |

**Inferred features are not roles.** Nobody paints a beam, a banister or a soffit. The engine reads them from the
arrangement of the stored roles around a cell, as cases of those roles:

| Inferred feature | Read from | Cases (§13) |
|---|---|---|
| beam | a wall or floor cell one out from a built face, open above, below and in front | `beam` |
| banister | a low, one-cell-thin wall run, open above (rails), and thin posts under it (wall or pillar) | `banister-rail`, `banister-post` |
| soffit | the underside of a floor or roof edge that projects: open below and in front | `soffit` |
| moulding | a wall face under a ceiling (a floor or roof cell above in front) | `moulding` |
| running board | the outside of a wall where a floor meets it inside: the storey line | `running-board` |
| foundation skirt | a foundation face whose foot meets the ground in front | `foundation-skirt` |

So painting a wall one cell further turns a banister into a low wall, and digging the cell behind a beam stops it
being a beam: the look always follows the voxels, in the editor and in a running game alike.

## 2. The neighbourhood a case reads

Every wall, floor, roof, foundation, stair, pillar and opening cell gets **one case**, chosen from the cells around
it within reach 2 (two cells in any direction). The engine reads 40 cells around the centre `@` (plans of the five
layers, x to the right, the front +z toward the bottom):

```text
 2 above     1 above     own level     1 below     2 below
                             x
    x         x x x        x x x        x x x         x
  x x x       x x x      x x @ x x      x x x       x x x
    x         x x x        x x x        x x x         x
                             x
```

That is the 26 cells touching it, the 6 two cells out along an axis, and the 8 beside the cells two above and two
below (what tells a post under a rail from a taller wall). Each of the 40 cells is read as one of these **symbols**:

- **open**: air, liquid, or a cell filled below the surface (a partly dug cell counts as open);
- **opening**: a cell with the opening role (open, but framed by its neighbours);
- **ground**: terrain filled to the surface;
- **built**: one of the six built roles (wall, floor, roof, foundation, stair, pillar), which role it is.

**Materials are not read.** The engine could also tell "built in the same material as the centre" from "another
material", but no rule of this draft uses that, and the engine then leaves it out entirely: a material paint (oak to
pine, stone to brick) never changes a case, so it never rebuilds geometry within one kit (the owner's feeds rule). A
future rule that reads materials would make paints rebuild meshes; see question 11.

**Turned and mirrored arrangements are the same case.** A case is written once in its own orientation: the face that
shows (its **front**) toward +z, its run along +x, up +y. The engine tries every rule under the four quarter turns
about the vertical and the mirror (left-right), never upside down: gravity tells a soffit (open below) from a running
board (open above). The piece is then placed with the same turn and mirror (plan view, x right, front down):

```text
 as authored     turn 1          turn 2          turn 3          mirrored
   run →           run ↓           run ←           run ↑           run ←
  ┌──────┐        ┌──┐            ┌──────┐          ┌──┐          ┌──────┐
  │ body │       F│  │            │ body │          │  │F         │ body │
  └──────┘        │  │            └──────┘          │  │          └──────┘
   front ↓        └──┘             front ↑          └──┘           front ↓
                  front ←                           front →        (its own +x now points left)
```

A quarter turn takes +x to +z; the mirror (x to −x) comes first. A piece must therefore look right mirrored, since the
engine may place it either way (question 6).

**Rules, priorities, fallbacks.** A rule is a pattern of some of the 40 cells, each accepting a set of symbols; cells
a rule does not list do not matter. Rules are tried from the highest priority down (equal priorities in list order),
each under all eight turns and mirrors; the first that fits names the case. A cell no rule fits takes its **role's
fallback case** (`wall-plain`, `floor-plain`, …). Every role with cases must have a fallback, or the engine refuses
the catalogue, so no construction cell is ever left without a case. Priorities in this draft: `enclosed` 100, the
inferred features 60–90, the role shapes 45–80, the plain wall's front rule 1.

## 3. Reading the case diagrams

Each rule is drawn as a **cut** through the centre (seen from the side: the back −z on the left, the front +z on the
right, up on top; the numbers are the layers) and a **plan** of the centre's level (seen from above: x to the right,
the front toward the bottom). A plan of another layer is added when the rule reads a cell there that the cut does not
show. The layer numbers at the left belong to the cut; a plan's rows run from the back (top) to the front (bottom).
Each character is one cell:

<!-- legend -->
| Symbol | The cell must be |
|---|---|
| `@` | the cell itself (the case's role) |
| `·` | anything (the rule does not look at it) |
| `o` | open: air or an opening |
| `a` | air (or liquid, or partly filled), not an opening |
| `D` | an opening (door or window gap) |
| `g` | ground (terrain) |
| `#` | built: any of the six built roles |
| `S` | solid: built or ground |
| `W` | wall |
| `F` | floor |
| `R` | roof |
| `N` | foundation |
| `T` | stair |
| `P` | pillar |
| `c` | a ceiling: floor or roof |
| `b` | something a wall stands on: ground, foundation or floor |
| `t` | something a door stands on: ground, floor, foundation or stair |
| `r` | anything but roof |
| `p` | anything but pillar |
| (blank) | outside the 40 cells the engine reads |
<!-- /legend -->

For example `wall-top` (§6) is "air above, open in front": in the cut, `a` above `@` and `o` to its right.

## 4. What a case decides

A case decides five things, all in the catalogue, none in the kit's art:

1. **Marking: REQUIRED, OPTIONAL, FALLBACK.** REQUIRED: a complete kit makes pieces for it; the kit check warns when
   it is missing and names what draws the cell instead. OPTIONAL: a kit may make pieces; without them the cell draws
   its role's fallback (or the base surface). FALLBACK: the case every cell of its role gets when nothing more
   specific fits; it is also required. Of the 46 cases, 40 are required (7 of them fallbacks) and 6 optional. In this
   draft a missing required case is a warning, never an error: every case is always drawn by something (question 5).
2. **The run and its sections.** A case with a run (along its own x, or up its own y) joins its neighbours of the same
   case or feature into runs, so long beams, rails, copings and skirts are built from a few sections, never from
   hand-made lengths. Each cell is one **section** of its run:

   ```text
    single      start   body   body   end        corner (L)      junction (T or cross)
    ┌──┐        ┌──┬────┬────┬──┐                ┌──┐             ┌──┐
    │  │        │s │ b  │ b  │ e│                │b │             │b │
    └──┘        └──┴────┴────┴──┘             ┌──┼──┘          ┌──┼──┬──┐
                 −x ─────────→ +x             │b │c │          │b │j │b │
                                              └──┴──┘          └──┴──┴──┘
   ```

   *single*: a run of one cell; *start*: the free end at the piece's own −x (−y for an upright run); *end*: the free
   end at its own +x (+y); *body*: joined at both ends; *corner*: the run turns (horizontal runs only); *junction*: three
   or four arms meet (horizontal runs only). Each end of a cell is **joined** (the run goes on), **open** (an exposed
   termination), **butt** (it stops against a solid cell) or **inner** (an inside corner, met in a mitre). Because a
   mirror swaps −x and +x, the two ends of a run are often both drawn by the `end` piece, one of them mirrored. A case
   with no run is always *single*. U along a run is anchored to the world, not to the run's start (trim layout §5),
   so an edit at one end never shifts the texture along the rest.
3. **The base surface: keep, suppress, reshape.** The base surface is the voxel-derived wall/floor/roof surface with
   its tileable textures. *keep*: the base surface draws the cell and a piece adds on top (a coping on a wall top);
   *suppress*: the base surface leaves the cell to the piece (a beam, a rail: there is no solid block under them);
   *reshape*: the base surface draws the case's coarse shape itself (a soffit's underside raised to half the cell).
4. **The coarse shape** that collision, navigation and light use, never the piece's mesh, so a kit's art cannot change
   gameplay and every kit of a material type collides the same. In sixteenths of a cell (1/16 = 3.125 cm), in the
   case's own orientation:

   | Shape | Box (x, y, z from–to, sixteenths) | Light blocked | Used by |
   |---|---|---|---|
   | box | 0–16, 0–16, 0–16 | 255 of 255 | most cases |
   | slab | 0–16, 8–16, 0–16 (upper half) | 128 | `soffit` |
   | panel | 0–16, 0–16, 6–10 (a thin upright sheet along the run) | 64 | `banister-rail` |
   | bar | 0–16, 3–13, 3–13 (a thick horizontal member along the run) | 100 | `beam` |
   | post | 6–10, 0–16, 6–10 (a thin upright bar) | 16 | `banister-post` |
   | none | nothing | 0 | the openings |

   A ball goes through a banister's gaps and a capsule stands on a beam (tested with the real physics engine).
5. **What draws it when the kit has no piece** (the fallback chain): the case's own section, else its `body`, else its
   `single`; then the role's fallback case's pieces, but only when that case has the same base and shape (a wall piece
   never stands in for a beam); then the **engine default kit** (simple boxes, engine-owned) where the base is
   suppressed, and nothing more where the base surface already draws the cell. Each case's block names its engine
   default piece. So a world with no game kit at all still draws every case.

## 5. Air, terrain and liquid: no cases

- **air** has nothing to draw.
- **terrain** is drawn by the terrain mesher's own rules (46b: cliffs, slopes, terraces, overhangs, caves), the same
  derive step but not kit cases. Where terrain meets construction, the construction cell reads it as `g` (ground):
  that is how a wall finds its foot (`wall-base`) and a foundation its skirt (`foundation-skirt`). The owner's "the
  same stair pattern is a smooth slope under the terrain role" is the terrain rules' job, not this spec's.
- **liquid** reads as open to every case (a wall in a pond sees water as air in front of it) until the water phase.

### Shared by every built role

#### `enclosed` · OPTIONAL

- **Roles:** wall, floor, roof, foundation, stair, pillar
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** no face open: nothing shows, no piece
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 100

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · S ·        · S ·
 0 · S @ S ·    · S @ S ·
-1   · S ·        · S ·
-2   · · ·          ·
```

A cell with all six faces against solid cells: nothing of it shows, so no piece is drawn and the kit needs none.
It is optional because it is never visible.

## 6. Wall

**Purpose.** Upright construction: house walls, garden walls, parapets, gables. A wall one cell thick is the common
case (0.5 m); thicker walls are fine. **Neighbours that change the choice:** an opening beside, above or below
(jamb, lintel, sill); air above (top); open on both faces (thin); the end of a one-cell-thick run (end); an outside
corner (corner); ground, a foundation or a floor at its foot (base); a floor behind it inside (running board); a
floor or roof over the room in front (moulding); a built face behind it with the cells above and below open (beam);
low and thin on a support (banister). **A kit must provide** the required wall cases below plus the wall's inferred
features (§13). **The engine falls back** to `wall-plain` (the base surface) and the default kit's copings, end boards,
corner posts, plinths and frame boards.

#### `wall-plain` · REQUIRED · FALLBACK

- **Roles:** wall · **Fallback of:** wall
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** an exposed wall face with no edge in reach (fallback): the base surface
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 1

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ o ·    · · @ · ·
-1   · · ·        · o ·
-2   · · ·          ·
```

The flat face of a wall with nothing special in reach. The base surface (tileable wall texture) draws it; a kit may
add a face piece (the log kit's half-logs, the stone kit's ashlar courses). Its only rule just names the front (the
open face), so the piece faces out of the wall, never along it.

#### `wall-thin` · OPTIONAL

- **Roles:** wall
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** a one-cell-thick wall, open in front and behind: the piece dresses both faces
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 46

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · o ·
 0 · o @ o ·    · · @ · ·
-1   · · ·        · o ·
-2   · · ·          ·
```

A wall one cell thick, open on both faces: the piece dresses both faces (the log kit's half-logs on both sides). It is
tried before `wall-base`, so a thin wall's foot is dressed on both faces too. Optional: without it the kit's
`wall-plain` piece dresses one face. See gap D480 (§18) for thin cells that also have a top, an end or an opening.

#### `wall-top` · REQUIRED

- **Roles:** wall
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a coping cap over the wall top, overhanging the face
- **Catalogue note:** the top edge of a wall: a coping cap
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 50

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · a ·        · · ·
 0 · · @ o ·    · · @ · ·
-1   · · ·        · o ·
-2   · · ·          ·
```

The top course of a wall: a coping, a top log, a capping stone. Runs along the wall; corners and the wall's ends are
its corner and start/end sections.

#### `wall-end` · REQUIRED

- **Roles:** wall
- **Run → sections:** up its own y → single, start, body, end
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** an end board up the free end (+x)
- **Catalogue note:** the free end of a one-cell-thick wall
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 55

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · o ·
 0 · o @ o ·    · S @ o ·
-1   · · ·        · o ·
-2   · · ·          ·
```

The free end of a one-cell-thick wall (open in front, behind and at its +x end; the wall continues at −x): an end
board, log ends, a quoin column. Runs upright (start at the bottom, end at the top).

#### `wall-corner` · REQUIRED

- **Roles:** wall
- **Run → sections:** up its own y → single, start, body, end
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a corner post up the outside corner (+x, +z)
- **Catalogue note:** an outside vertical corner
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 54

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ o ·    · · @ o ·
-1   · · ·        · o o
-2   · · ·          ·
```

An outside vertical corner (open in front, at +x and diagonally between): log ends crossing, quoins. Runs upright.

#### `wall-base` · OPTIONAL

- **Roles:** wall
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a plinth at the foot of the face
- **Catalogue note:** the foot of a wall on ground, a foundation or a floor: a plinth
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 45

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ o ·    · · @ · ·
-1   · b S        · o ·
-2   · · ·          ·
```

The foot of a wall where it stands on ground, a foundation or a floor: a plinth. Optional: without it the plain face
runs to the ground.

#### `wall-jamb` · REQUIRED

- **Roles:** wall
- **Run → sections:** up its own y → single, start, body, end
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a frame board beside the opening (+x)
- **Catalogue note:** beside an opening: the frame side
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 65

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ · ·    · · @ D ·
-1   · · ·        · · ·
-2   · · ·          ·
```

The wall cell beside an opening (the opening at its +x): the frame's side. Runs upright.

#### `wall-lintel` · REQUIRED

- **Roles:** wall
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a header over the opening below
- **Catalogue note:** over an opening
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 64

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ o ·    · · @ · ·
-1   · D ·        · o ·
-2   · · ·          ·
```

The wall cell over an opening: a lintel or header. Names its front, so the piece faces out of the wall plane.

#### `wall-sill` · REQUIRED

- **Roles:** wall
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a sill ledge under the opening above
- **Catalogue note:** under an opening
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 63

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · D ·        · · ·
 0 · · @ o ·    · · @ · ·
-1   · · ·        · o ·
-2   · · ·          ·
```

The wall cell under a window opening: a sill ledge. Names its front as the lintel does.

## 7. Floor

**Purpose.** Horizontal construction: storey floors, balconies, flat ceilings, decks. **Neighbours that change the
choice:** open in front (edge), open at the front and side (corner), open below and in front (soffit, §13), a built
face behind with open cells above and below (a floor-level beam, §13). **A kit must provide** the edge and corner
pieces; the plain floor is the base surface. **The engine falls back** to the base surface and the default kit's
edge band.

#### `floor-plain` · REQUIRED · FALLBACK

- **Roles:** floor · **Fallback of:** floor
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** a floor with no edge in reach (fallback): the base surface
- **Rules:** none. Every floor cell no other rule takes is this case.

A floor with no edge in reach: the base surface (tileable floor texture on top, ceiling texture underneath) draws it.

#### `floor-edge` · REQUIRED

- **Roles:** floor
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a band along the slab edge
- **Catalogue note:** the exposed edge of a floor slab
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 50

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ o ·    · · @ · ·
-1   · · ·        · o ·
-2   · · ·          ·
```

The exposed edge of a floor slab: an edge band, a joist end, a board end. Runs along the edge.

#### `floor-corner` · REQUIRED

- **Roles:** floor
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** the band round the outside corner
- **Catalogue note:** an outside corner of a floor slab
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 52

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ o ·    · · @ o ·
-1   · · ·        · o ·
-2   · · ·          ·
```

An outside corner of a floor slab (open in front and at +x).

## 8. Roof

**Purpose.** Roofs on the 45° stepped pattern (one cell up for one cell across) and flat roofs. The owner's rule: the
same stair pattern means different geometry by role, so a roof step becomes a roof slope piece, never a stair. The
roof kit has peaks, gables (verges), hips, valleys, ridges, eaves and soffits, as the wall kit has corners and caps.
Only 45° ships at first; a 2:1 (about 27°) pattern is a later option. In the case's orientation a slope rises toward
the back (−z). **Neighbours that change the choice:** air above and in front (every roof case), roof cells on the
diagonals (slope, ridge, hip, valley), a non-roof cell below the front (eave), air at the side with roof behind
(verge). **A kit must provide** every roof case but the plain one; **the engine falls back** to the base surface and
the default kit's finial, ridge cap, barge board, fascia and curb (hips, valleys and slopes draw as base surface).

#### `roof-plain` · REQUIRED · FALLBACK

- **Roles:** roof · **Fallback of:** roof
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** a roof cell with no slope or edge in reach (fallback)
- **Rules:** none. Every roof cell no other rule takes is this case.

A roof cell with no slope or edge in reach (inside a thick roof, or a flat roof's middle): the base surface.

#### `roof-peak` · REQUIRED

- **Roles:** roof
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a finial on the peak
- **Catalogue note:** open on all four sides and above: the top of a pyramid or a spire
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 80

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · a ·        · a ·
 0 · a @ a ·    · a @ a ·
-1   · · ·        · a ·
-2   · · ·          ·
```

Open on all four sides and above: the top of a pyramid roof or a spire. A finial.

#### `roof-ridge` · REQUIRED

- **Roles:** roof
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a ridge cap along the top
- **Catalogue note:** the top of two slopes meeting
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 78

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · a ·        · a ·
 0 · a @ a ·    · · @ · ·
-1   R · R        · a ·
-2   · · ·          ·
```

The top of two slopes meeting: air above, in front and behind, roof cells diagonally below on both sides. A ridge cap
along the ridge.

#### `roof-hip` · REQUIRED

- **Roles:** roof
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** an outside corner of two slopes
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 76

```text
   cut x=0      plan y+1    plan y 0
   back→front   x→ front↓   x→ front↓
+2   · · ·                      ·
+1   · a ·        R · ·       · R ·
 0 · R @ a ·      · a ·     · R @ a ·
-1   · · ·        · · ·       · a ·
-2   · · ·                      ·
```

An outside corner where two slopes meet (a hipped roof's corner).

#### `roof-valley` · REQUIRED

- **Roles:** roof
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** an inside corner of two slopes
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 75

```text
   cut x=0      plan y+1    plan y 0
   back→front   x→ front↓   x→ front↓
+2   · · ·                      ·
+1   R a ·        · R ·       · · ·
 0 · · @ R ·      R a ·     · · @ R ·
-1   · · ·        · · ·       · R a
-2   · · ·                      ·
```

An inside corner where two slopes meet (where an L-shaped roof turns).

#### `roof-verge` · REQUIRED

- **Roles:** roof
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a barge board at the gable end (+x)
- **Catalogue note:** the end of a slope at a gable: the verge
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 72

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   R a ·        · · ·
 0 · · @ a ·    · R @ a ·
-1   · · ·        · a ·
-2   · · ·          ·
```

The end of a slope at a gable: open at the side, the slope continuing behind and up. A barge board.

#### `roof-eave` · REQUIRED

- **Roles:** roof
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a fascia board under the eave
- **Catalogue note:** the lowest step of a slope: the eave with its fascia
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 70

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   R a ·        · · ·
 0 · · @ a ·    · · @ · ·
-1   · · r        · a ·
-2   · · ·          ·
```

The lowest step of a slope (nothing of the roof below its front): the eave, with its fascia. The underside of a
projecting eave is a `soffit` (§13).

#### `roof-slope` · REQUIRED

- **Roles:** roof
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** a 45° step of the stair pattern under the roof role
- **Rules:** 2, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 68

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   R a ·        · · ·
 0 · · @ a ·    · · @ · ·
-1   · · R        · a ·
-2   · · ·          ·
```

Rule 2 · priority 67

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · a ·        · · ·
 0 · · @ a ·    · · @ · ·
-1   · · R        · a ·
-2   · · ·          ·
```

A step of the 45° pattern under the roof role: the roof covering itself (tiles, shingles). Two rules: a step with a
roof cell up-behind and down-in-front (mid-slope), and one with only a roof cell down-in-front (the last step under
the ridge or a peak).

#### `roof-edge` · REQUIRED

- **Roles:** roof
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a curb along the flat roof edge
- **Catalogue note:** the edge of a flat roof
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 50

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · a ·        · · ·
 0 · · @ a ·    · · @ · ·
-1   · · ·        · a ·
-2   · · ·          ·
```

The edge of a flat roof (air above and in front): a curb or parapet cap.

## 9. Foundation

**Purpose.** What a building stands on, meeting the terrain: plinths, platforms, footings. The owner's rule: a
foundation skirts into the terrain (§13 `foundation-skirt`). **Neighbours that change the choice:** ground in front
and below (skirt), open in front clear of the ground (edge), open at the front and side (corner). **A kit must
provide** the skirt, edge and corner; **the engine falls back** to the base surface and the default kit's skirt,
quoin and band.

#### `foundation-plain` · REQUIRED · FALLBACK

- **Roles:** foundation · **Fallback of:** foundation
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** a foundation with no exposed edge in reach (fallback)
- **Rules:** none. Every foundation cell no other rule takes is this case.

A foundation face with no exposed edge in reach: the base surface.

#### `foundation-corner` · REQUIRED

- **Roles:** foundation
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a quoin up the outside corner
- **Catalogue note:** an outside corner of a foundation
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 55

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ o ·    · · @ o ·
-1   · · ·        · o ·
-2   · · ·          ·
```

An outside corner of a foundation: a quoin.

#### `foundation-edge` · REQUIRED

- **Roles:** foundation
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a band under the top of the exposed face
- **Catalogue note:** an exposed foundation face clear of the ground
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 50

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ o ·    · · @ · ·
-1   · · ·        · o ·
-2   · · ·          ·
```

An exposed foundation face clear of the ground (a platform's raised side): a band under its top.

## 10. Stair

**Purpose.** The 45° stepped pattern you walk up, under the stair role (the same pattern under the roof role is a
roof slope, under terrain a smooth slope). In the case's orientation the flight climbs toward the back (−z).
**Neighbours that change the choice:** stair cells on the diagonals (step), air at the side of the flight (side).
**A kit must provide** step and side pieces; **the engine falls back** to the base surface and the default kit's
nosing and stringer. Walking and collision follow the voxels (the steps), never the pieces.

#### `stair-plain` · REQUIRED · FALLBACK

- **Roles:** stair · **Fallback of:** stair
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** a stair cell off the step pattern (fallback): a landing
- **Rules:** none. Every stair cell no other rule takes is this case.

A stair cell off the step pattern: a landing.

#### `stair-step` · REQUIRED

- **Roles:** stair
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a nosing on the step
- **Catalogue note:** a step of the 45° stair pattern under the stair role
- **Rules:** 2, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 60

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   T a ·        · · ·
 0 · · @ a ·    · · @ · ·
-1   · · ·        · a ·
-2   · · ·          ·
```

Rule 2 · priority 60

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · a ·        · · ·
 0 · · @ a ·    · · @ · ·
-1   · · T        · a ·
-2   · · ·          ·
```

A step of the flight: a tread with its nosing. Runs across the flight.

#### `stair-side` · REQUIRED

- **Roles:** stair
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a stringer on the open side (+x)
- **Catalogue note:** a step at the open side of a flight: the stringer
- **Rules:** 2, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 62

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   T a ·        · · ·
 0 · · @ a ·    · · @ a ·
-1   · · ·        · a ·
-2   · · ·          ·
```

Rule 2 · priority 62

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · a ·        · · ·
 0 · · @ a ·    · · @ a ·
-1   · · T        · a ·
-2   · · ·          ·
```

A step at the open side of the flight: the stringer.

## 11. Pillar

**Purpose.** Free-standing columns one cell across. A pillar against other cells is drawn as a plain block.
**Neighbours that change the choice:** open on all four sides (free), pillar cells above and below (base, shaft,
capital, single), a rail above (a banister post, §13). **A kit must provide** the free pillar's pieces; **the engine
falls back** to the base surface and the default kit's plinths and caps.

#### `pillar-plain` · REQUIRED · FALLBACK

- **Roles:** pillar · **Fallback of:** pillar
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** a pillar against other cells (fallback)
- **Rules:** none. Every pillar cell no other rule takes is this case.

A pillar cell with something beside it (built into a wall or a corner): the base surface.

#### `pillar-single` · REQUIRED

- **Roles:** pillar
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a plinth and a cap
- **Catalogue note:** a free pillar one cell high
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 60

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · p ·        · o ·
 0 · o @ o ·    · o @ o ·
-1   · p ·        · o ·
-2   · · ·          ·
```

A free pillar one cell high: base and capital in one piece.

#### `pillar-base` · REQUIRED

- **Roles:** pillar
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a plinth at the foot
- **Catalogue note:** the foot of a free pillar
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 58

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · P ·        · o ·
 0 · o @ o ·    · o @ o ·
-1   · p ·        · o ·
-2   · · ·          ·
```

The foot of a free pillar (pillar above, none below).

#### `pillar-capital` · REQUIRED

- **Roles:** pillar
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a cap at the head
- **Catalogue note:** the head of a free pillar
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 58

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · p ·        · o ·
 0 · o @ o ·    · o @ o ·
-1   · P ·        · o ·
-2   · · ·          ·
```

The head of a free pillar (pillar below, none above).

#### `pillar-shaft` · REQUIRED

- **Roles:** pillar
- **Run → sections:** up its own y → single, start, body, end
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** none: the base surface draws the cell
- **Catalogue note:** the middle of a free pillar
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 55

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · P ·        · o ·
 0 · o @ o ·    · o @ o ·
-1   · P ·        · o ·
-2   · · ·          ·
```

The middle of a free pillar (pillar above and below). Runs upright.

## 12. Opening

**Purpose.** The gap a door or window goes in. The opening cells are open for every consumer (shape none): you walk
and see through them. Their cases draw the **frame** round the gap; the doors, leaves, glass and shutters are props
placed into standard openings (47a), not kit pieces. An opening's frame is the solid in its own plane (x and y); its
front and back are open. **Neighbours that change the choice:** the solid cells round it (single), ground, a floor, a
foundation or a stair below (threshold: a door), another solid below (sill: a window), solid above (head), solid at
the side (jamb). The wall cells round an opening have their own cases (`wall-jamb`, `wall-lintel`, `wall-sill`, §6):
a kit may frame an opening from either side. **The engine falls back** to nothing inside a large opening and the
default kit's frame boards at its edges.

#### `opening-plain` · REQUIRED · FALLBACK

- **Roles:** opening · **Fallback of:** opening
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): none
- **Engine default kit:** none: nothing is drawn (an open gap)
- **Catalogue note:** inside a larger opening (fallback): no frame in reach
- **Rules:** none. Every opening cell no other rule takes is this case.

An opening cell with no frame in reach (inside a large opening): nothing is drawn.

#### `opening-single` · REQUIRED

- **Roles:** opening
- **Run → sections:** none → single only
- **Base:** keep · **Coarse shape** (collision, navigation, light): none
- **Engine default kit:** a frame on four sides
- **Catalogue note:** a one-cell opening framed on four sides
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 60

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · S ·        · · ·
 0 · · @ · ·    · S @ S ·
-1   · S ·        · · ·
-2   · · ·          ·
```

A one-cell opening framed on all four sides: the whole frame in one piece.

#### `opening-threshold` · REQUIRED

- **Roles:** opening
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): none
- **Engine default kit:** a threshold board
- **Catalogue note:** the bottom of an opening on a floor or ground: a door
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 58

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ a ·    · · @ · ·
-1   · t ·        · a ·
-2   · · ·          ·
```

The bottom of an opening standing on ground, a floor, a foundation or a stair: a door's threshold. Runs across the
opening.

#### `opening-sill` · REQUIRED

- **Roles:** opening
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): none
- **Engine default kit:** a window sill
- **Catalogue note:** the bottom of an opening on a wall: a window
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 56

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ a ·    · · @ · ·
-1   · S ·        · a ·
-2   · · ·          ·
```

The bottom of an opening standing on another solid (a wall): a window sill.

#### `opening-head` · REQUIRED

- **Roles:** opening
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): none
- **Engine default kit:** a head board
- **Catalogue note:** the top of an opening
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 54

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · S ·        · · ·
 0 · · @ a ·    · · @ · ·
-1   · · ·        · a ·
-2   · · ·          ·
```

The top of an opening: a head board.

#### `opening-jamb` · REQUIRED

- **Roles:** opening
- **Run → sections:** up its own y → single, start, body, end
- **Base:** keep · **Coarse shape** (collision, navigation, light): none
- **Engine default kit:** a jamb board (+x)
- **Catalogue note:** the side of an opening
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 52

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ · ·    · · @ S ·
-1   · · ·        · · ·
-2   · · ·          ·
```

The side of an opening (solid at its +x): a jamb. Runs upright.

## 13. Inferred features

These are cases of the stored roles (they list which), drawn by the kit like any other case. Three of them replace
the cell's block entirely (beam, banister rail, banister post: base suppressed, a thin coarse shape), so an open
railing really is open.

#### `beam` · REQUIRED

- **Roles:** wall, floor · **Inferred feature:** beam
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** suppress · **Coarse shape** (collision, navigation, light): bar
- **Engine default kit:** none: the engine's stand-in bar (every kit's last fallback)
- **Catalogue note:** one cell out from a wall body, open above and below
- **Rules:** 3, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 90

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   # o ·        · # ·
 0 · # @ o ·    · · @ · ·
-1   # o ·        · o ·
-2   · · ·          ·
```

Rule 2 · priority 90

```text
   cut x=0      plan y+1    plan y 0    plan y-1
   back→front   x→ front↓   x→ front↓   x→ front↓
+2   · · ·                      ·
+1   # o o        · # ·       · # ·       · # ·
 0 · # @ # ·      # o o     · # @ # ·     # o o
-1   # o o        · o ·       · # ·       · o ·
-2   · · ·                      ·
```

Rule 3 · priority 90

```text
   cut x=0      plan y+1    plan y 0    plan y-1
   back→front   x→ front↓   x→ front↓   x→ front↓
+2   · · ·                      ·
+1   o o ·        # o ·       # # ·       # o ·
 0 · # @ o ·      o o ·     · # @ o ·     o o ·
-1   o o ·        · · ·       · o ·       · · ·
-2   · · ·                      ·
```

A wall or floor cell sticking one cell out from a built face, open above, below and in front: a beam along the face
(log, timber, iron). Rule 2 is a beam round a wall's inside corner, rule 3 round its outside corner. A wall painted
over a beam turns it back into wall; a beam whose wall behind is dug stops being a beam (gap D482).

#### `banister-rail` · REQUIRED

- **Roles:** wall · **Inferred feature:** banister
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** suppress · **Coarse shape** (collision, navigation, light): panel
- **Engine default kit:** none: the engine's stand-in panel (every kit's last fallback)
- **Catalogue note:** a low thin run, open above: on a post, between posts or on a wider support
- **Rules:** 6, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 86

```text
   cut x=0      plan y 0    plan y-1
   back→front   x→ front↓   x→ front↓
+2   · · ·          ·
+1   · o ·        · o ·       · o ·
 0 · o @ o ·    · · @ · ·     o # o
-1   o # o        · o ·       · o ·
-2   · S ·          ·
```

Rule 2 · priority 86

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · o ·        · o ·
 0 · o @ o ·    · · @ · ·
-1   · o ·        · o ·
-2   · S ·          ·
```

Rule 3 · priority 86

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · o ·        · o ·
 0 · o @ o ·    · · @ · ·
-1   · S S        · o ·
-2   · · ·          ·
```

Rule 4 · priority 86

```text
   cut x=0      plan y+1    plan y 0    plan y-1
   back→front   x→ front↓   x→ front↓   x→ front↓
+2   · · ·                      ·
+1   · o o        · · ·       o o o       · S ·
 0 · o @ # ·      · o o     · o @ # ·     S S ·
-1   S S ·        · o ·       o # o       · · ·
-2   · · ·                      ·
```

Rule 5 · priority 86

```text
   cut x=0      plan y+1    plan y 0
   back→front   x→ front↓   x→ front↓
+2   · · ·                      ·
+1   · o o        · · ·       o o o
 0 · o @ # ·      o o o     · # @ # ·
-1   S S ·        · o ·       o # o
-2   · · ·                      ·
```

Rule 6 · priority 86

```text
   cut x=0      plan y+1    plan y 0    plan y-1
   back→front   x→ front↓   x→ front↓   x→ front↓
+2   · · ·                      ·
+1   o o o        · o ·       o # o       · · ·
 0 · # @ # ·      o o o     · # @ # ·     · S ·
-1   · S ·        · o ·       o # o       · · S
-2   · · ·                      ·
```

A run of a low, one-cell-thin wall, open above: the rail. Rule 1: on a post; rule 2: spanning one open cell between
posts (a support two below); rule 3: on a support wider than itself (a balcony's slab edge); rules 4–6: where rails on
a wider support meet in an L, a T and a cross (corner and junction sections). Grow the rail one cell higher and it
becomes a thin wall with a top.

#### `banister-post` · REQUIRED

- **Roles:** wall, pillar · **Inferred feature:** banister
- **Run → sections:** none → single only
- **Base:** suppress · **Coarse shape** (collision, navigation, light): post
- **Engine default kit:** none: the engine's stand-in post (every kit's last fallback)
- **Catalogue note:** thin both ways on a support, under a rail
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 88

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · o ·          ·
+1   o # o        · o ·
 0 · o @ o ·    · o @ o ·
-1   · S ·        · o ·
-2   · · ·          ·
```

A cell thin both ways, open on all four sides, on a support and under a rail (wall or pillar role): a post or
baluster. It has no run: each post is a single.

#### `running-board` · OPTIONAL

- **Roles:** wall · **Inferred feature:** running-board
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a board along the storey line
- **Catalogue note:** the outside of a wall where a floor meets it inside: the storey line
- **Rules:** 2, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 70

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · W ·        · F ·
 0 · F @ a ·    · · @ · ·
-1   · W ·        · a ·
-2   · · ·          ·
```

Rule 2 · priority 70

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · W ·        F · ·
 0 · · @ a ·    · · @ a ·
-1   · W ·        · a ·
-2   · · ·          ·
```

The outside face of a wall where a floor meets it inside (wall above and below): the board along the storey line. Rule 2 is the storey line
round an outside corner. Optional: without it the plain wall face runs past the floor.

#### `moulding` · OPTIONAL

- **Roles:** wall · **Inferred feature:** moulding
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a moulding under the ceiling
- **Catalogue note:** a wall face under a ceiling: the moulding in the corner
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 68

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · # c        · · ·
 0 · · @ a ·    · · @ · ·
-1   · · ·        · a ·
-2   · · ·          ·
```

A wall face under a ceiling (a floor or roof cell above in front of it): the moulding in the corner of the room.
Inside corners meet in a mitre. Optional.

#### `soffit` · OPTIONAL

- **Roles:** floor, roof · **Inferred feature:** soffit
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** reshape · **Coarse shape** (collision, navigation, light): slab
- **Engine default kit:** none: the base surface draws the slab
- **Catalogue note:** the underside of a projecting edge: open below and in front (its underside raised to half the cell)
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 60

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ a ·    · · @ · ·
-1   · a a        · a ·
-2   · · ·          ·
```

The underside of a projecting floor or roof edge (open below, in front, and diagonally below in front): a balcony's
or an eave's soffit. Its base is reshaped: the underside is raised to half the cell, so its coarse shape is the upper
half (you stand on it, walk under it). Optional: without a piece the reshaped base surface still closes it.

#### `foundation-skirt` · REQUIRED

- **Roles:** foundation · **Inferred feature:** foundation-skirt
- **Run → sections:** along its own x → single, start, body, end, corner, junction
- **Base:** keep · **Coarse shape** (collision, navigation, light): box
- **Engine default kit:** a skirt where the foundation meets the ground
- **Catalogue note:** an exposed foundation face meeting the ground in front
- **Rules:** 1, tried in this order (an "or": any one matching is enough)

Rule 1 · priority 70

```text
   cut x=0      plan y 0
   back→front   x→ front↓
+2   · · ·          ·
+1   · · ·        · · ·
 0 · · @ o ·    · · @ · ·
-1   · · g        · o ·
-2   · · ·          ·
```

A foundation face whose foot meets the ground in front: the skirt where the building meets the terrain. Runs along
the face.

## 14. Detail levels: high, low, none

Pieces are drawn by distance ring (46b's levels):

| Level | Cells | What draws |
|---|---|---|
| L0 (near) | 0.5 m | the kit's **high** pieces, on cases read from the 0.5 m voxels |
| L1 (middle) | 1 m | the kit's **low** pieces (the high one where a case has no low), on cases read from the 1 m voxels and drawn at twice the size |
| L2 and coarser | 2 m and up | **no pieces**: the voxel-derived base surface alone |

On staging (46c.10) high pieces showed to about 75 m, low from about 90 m and none from about 240 m; these are the
current ring settings, not art guarantees. A low piece keeps the silhouette, openings and construction character
(fewer sides on a log, no small mouldings); it uses the same UV regions as its high (trim layout §5), so a level
switch never jumps the texture. The kit check reports a missing low (info) and a low heavier than its high (warning).
A low piece is authored in the same 0.5 m cell space as its high and drawn twice the size on a 1 m cell (question 7).

## 15. Variants and mirroring

- **Variants.** Each section may have several variants with weights (two ashlar bonds, a knotted log). The variant
  of a cell is picked from a hash of its world cell and its kit, never of load order or neighbours, so digging or
  building elsewhere never reshuffles a surviving piece, and a new kit revision keeps every variant where it was.
- **Mirroring.** The engine places a piece mirrored where the case's fit needs it (§2). Make pieces that read right
  mirrored (no lettering, no handed hardware); the debug texture's numbers read mirrored on such faces by design.
  The engine keeps a mirrored copy of the mesh, so winding and lighting stay correct.

## 16. Building a piece

These match what the engine draws and the kit check tests (`tools/voxel-bench/kit-house.test.ts`,
`project-model` `voxel-kit-check.ts`):

- **Units and pivot.** Metres. The object's origin is the **centre of the cell**; the cell is −0.25 … +0.25 m on each
  axis (0.5 m). The piece must touch its cell (else an error: it draws beside it) and may reach up to half a cell past
  it, to ±0.5 m from the centre (a coping's overhang, a plinth standing proud); past that a warning. Keep the object at
  the origin with no rotation or scale (apply them).
- **Axes in the case's own orientation** (glTF, +y up): the front (the face that shows) toward **+z**, the run along
  **+x**, up **+y**. In Blender (Z up; the glTF exporter turns it): the front toward **−Y** (the side you see in the
  Front view, numpad 1), the run along **+X**, up **+Z**. The voxel body the piece sits on is behind it, toward Blender
  +Y; leave out faces that lie against it (no hidden geometry).
- **Sections.** `body` meets its neighbours at the cell's −x and +x faces; `start` is the free end at −x, `end` at +x
  (for upright runs: start at the bottom, end at the top); a `corner` joins one neighbour along its own x and one across it (z), placed turned and mirrored to fit the L;
  `single` is both ends free. Each end names a **join profile** (a closed outline in sixteenths of the end face); the
  kit check warns when two sections meeting at a face name different outlines.
- **Faces.** Front faces outward; the base surface draws the cell's own faces where the base is kept, so a kept-base
  piece adds on top of them (a coping, a band) rather than rebuilding the wall.
- **Collision, navigation and light never read the mesh**: they come from the case's coarse shape (§4).
- **Texturing.** Either the trim layout for detail pieces ([voxel-trim-layout.md](voxel-trim-layout.md), its own
  draft) or the piece's own bakes with the material arrays; the case list is the same for both.
- **Blender names.** One node (object) a piece: `<case>_<section>_v<k>_<high|low>`, e.g. `wall-top_body_v0_high`,
  `wall-top_body_v0_low`, `beam_end_v1_high`: letters, digits, `-` and `_` only (three's loader strips `.`, `:` and
  `/`). The placeholder script `tools/voxel-bench/kits/make_placeholder_kits.py` writes exactly these names; a kit's
  record lists each case's sections, their variants (high, optional low, weight) and join profiles. Kits name cases
  by the ids on this page, which become the contract once approved.

The two placeholder kits made to this draft (engine test data, not game art): **log** covers `wall-plain`,
`wall-thin`, `wall-top`, `wall-end`, `wall-corner`, `beam`, `banister-rail`, `banister-post`, `running-board`,
`moulding`, `foundation-skirt`, `soffit`; **stone** covers `wall-plain`, `wall-thin`, `wall-top`, `wall-corner`,
`wall-end`, `wall-base`, `moulding`, `foundation-skirt` and the five opening frames. Both pass the kit check with no
error (46c.9, 46c.10).

## 17. The kit check and the test scene

The kit check (Problems in the editor, `tl_diagnostics` for MCP) lists for a kit: every case of this page it has or
lacks (required: warn with what draws instead; optional: info), each role's fallback, high/low pairs, missing or
unreadable meshes, pivots and the ±0.5 m envelope, join profiles, triangle and texture budgets (reported, never
capped) and, for kits that opt in, the trim layout rows. The **kit test scene** (`writeKitTestScene`) lays out every
case of this page as a labelled exhibit (one exhibit for each case and each role it can be), so an artist sees every
piece of the kit in place on staging.

## 18. Known gaps (for the owner)

From the prototype on staging (46c.10), in plain words:

- **D480: a thin wall cell with a second feature dresses one face or none.** A cell has one case. A one-cell-thick
  wall's top course, the cells round a door or window, and its corner and end cells are `wall-top`, `wall-jamb`,
  `wall-lintel`, `wall-sill`, `wall-corner` or `wall-end`, whose pieces dress the front face only; the back face shows
  the bare base surface there (between dressed log courses). Choice for the owner: thin variants of those cases
  (`wall-top-thin`, …: more cases, more pieces) or two pieces a cell, one a face (question 2).
- **D481: a corner piece has one run direction for its texture.** A corner piece's two faces belong to two runs (along
  x and along z), but a piece carries one U direction, so with the trim layout only one face's texture can follow its
  run. Today the log corner draws its log ends only and leaves both faces bare. Fix: a second U direction per face, or
  two pieces in a corner cell (question 3).
- **D482: a beam whose wall is dug away stops being a beam.** The beam case needs the wall behind it. Dig that wall and
  the freed cells read as a one-cell-thin wall (a bar with a top log), not a free-spanning beam or a stub. The draft
  has no free-span beam case (question 4).
- **D483: at the middle distance (L1) the stone house shows a second band under its coping**, and its courses and
  quoins look twice their size (the low piece drawn on a 1 m cell). Seen once, not investigated (question 7).

Other limits of this draft (46c decision log):

- Reach 2 cannot tell an eave's soffit from the edge of an inside stairwell (both open below and in front), nor see a
  wall more than one cell behind a deep eave (question 1).
- Beams come from wall and floor cells only and need a wall behind, so a beam T junction never arises. Rails on posts
  over gaps do not turn corners (only rails on a wider support do). A rail between posts does not check its
  support's thickness.
- Hip, valley, peak and flat-roof cases are reached only by the test scene's generated windows; no test world builds
  them, so their rules are unproven on real roofs.
- Openings get one frame case a cell; where a head meets a jamb the frame's corner is left to the run sections.
- Copings stop against `wall-corner` cells (butt) rather than turning the corner; a running board's and a soffit's
  inside corners are mitres.

## 19. Open questions for the owner

1. **Reach.** Is two cells enough (soffits and mouldings under deep eaves, a stairwell edge vs an eave)? Growing it
   costs derive time and a larger job apron.
2. **Thin walls with a second feature (D480).** Thin variants of top, end, corner, jamb, lintel and sill (six more
   cases), or two pieces a cell (one each face)?
3. **Corner texture direction (D481).** A second U direction per face, or two pieces in a corner cell?
4. **Free beams (D482).** Add a free-span beam (and a stub) case for beams whose wall is gone, or leave them to read
   as thin walls?
5. **Required means what?** Should a kit missing a required case fail the kit check (error), or stay a warning as now
   (something always draws it)? And is the required/optional split on this page the one you want (40 required, 6
   optional)?
6. **Mirroring.** Keep "every piece must read right mirrored", or let a kit add an explicitly mirrored piece for
   handed details?
7. **Low pieces (D483).** Author low pieces for the 0.5 m cell and draw them twice the size at 1 m (as now), or
   author a separate low piece for a 1 m cell?
8. **Roofs.** Is the roof set right (plain, peak, ridge, hip, valley, verge, eave, slope, edge, plus soffit)? Should
   hips, valleys and verges run (sections) rather than be single pieces? 45° only for now?
9. **Slopes by role.** Stair-role steps get stair cases; terrain-role steps are the terrain mesher's smooth slope (no
   kit cases). Is "stairs under the ground role" (plan 45 §1) meant as terrain, or should a terrain step next to
   construction get a stair case?
10. **Openings.** One frame case a cell, frame corners from the sections, nothing drawn inside a large opening; door
    and window props in 47a. Should a kit frame an opening from the opening cells, the wall cells round it, or both
    (both are possible now)?
11. **Materials.** Keep every rule blind to materials (a material paint is shader data only), as this draft does?
    A rule that tells oak from stone would make paints rebuild meshes.
12. **Banisters.** Rails come only from the wall role and posts from wall or pillar. Should a rail also come from
    other roles, and should rails over gaps turn corners?
13. **Foundation skirts.** The skirt is a kit piece on the foundation face where ground is in front. Is that "skirts
    into terrain", or should the terrain surface also blend up the foundation (46d's material work)?
14. **Free role values.** Six of the 16 role values are unassigned. Any role to add before v1 (a terrace, a ledge,
    fence, …)? Adding one later is add-only, but every kit then needs its cases.
15. **Case names.** Are the case ids on this page the names you want kits to use? After approval a rename needs a
    versioned step.
16. **A paint that moves cells to another kit (46c.6b).** Material and wetness are shader data only, with one
    exception kept as the default: a material paint that changes a cell's kit (stone painted timber) rebuilds the
    geometry of the sections holding the painted cells, since kits are per material type. A paint within one kit and
    any wetness change never do. Keep that exception, or resolve pieces at draw time (instances carry case, section
    and cell hash; the renderer maps material → kit → piece)? The cost of the alternative: the derive no longer knows
    which pieces exist (missing-piece fallbacks, per-kit variant weights and the high/low choice move to the
    renderer), and instance lists grow to every cell any kit might draw.
17. **Fronts named by the rule (46c.10).** Every case whose piece shows on a face names that face in its rule (a
    fallback by a lowest-priority "front open" rule), so the matcher never picks an arbitrary turn. Make this a rule
    of the role spec for every future case?
18. **The engine default kit (46c.7).** Materials no kit binds draw the engine default kit, whose pieces add only to
    kept bases (copings, plinths, sills, edges, mouldings, skirts, frames); beams, rails and posts stay the engine's
    stand-in pieces. Is that the default you want for unbound materials?

## 20. What you are approving

Approving this page freezes it as role spec v1 (46c.16 renames the catalogue `cases-v1`, not a draft; changes after
that are versioned, add-only steps with an owner note). Tick each, or mark what to change:

- [ ] The ten stored roles and their values (§1), six values left free.
- [ ] Beams, banisters, soffits, mouldings, running boards and foundation skirts as inferred cases, never roles (§1, §13).
- [ ] The neighbourhood: reach 2, the 40 cells, the four kinds of symbol, materials not read (§2).
- [ ] Folding over four turns and the mirror, never upside down; the front +z, run +x, up +y convention (§2).
- [ ] The 46 cases per role, each with its marking: required, optional, fallback (§5–§13).
- [ ] Runs and their sections (single, start, body, end, corner, junction) and ends (joined, open, butt, inner) (§4).
- [ ] Base keep / suppress / reshape and the coarse shapes collision, navigation and light use (§4).
- [ ] The fallback chain and the engine default kit (§4).
- [ ] High at L0, low at L1, none from L2 (§14).
- [ ] Variants by world cell; pieces must read right mirrored (§15).
- [ ] Material and wetness never rebuild pieces, with one exception: a material paint that moves cells to another
  kit rebuilds the geometry of the sections holding them (same-kit paints and wetness are shader data only);
  alternative: choose pieces at draw time, at the cost in question 16.
- [ ] The piece convention: pivot at the cell centre, ±0.5 m envelope, axes, Blender node names (§16).
- [ ] Your answers to the open questions (§19); the known gaps (§18) fixed after approval as you choose.
