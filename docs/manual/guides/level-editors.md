# Level editors

**Goal:** know the four editors a level is made in, how to open each, and
what they share — moving around, selecting, the Esc key, the panels over
the view, framing — so moving from one to the next needs nothing new.

Each is a full-screen **edit mode** on the live Scene view (no second
view): a header naming what you edit with **Done** (Esc), a **rail** of
modes on the left (Shift+1 … Shift+9), the mode's **column** on the right,
**panels** over the view, and a **status line** at the bottom with the
tool, what to do and its keys. An object editor shows only that object;
**Context** (C) shows the rest of the scene, not pickable. Every stroke or
click is one command and one undo step (Ctrl+Z), the same command MCP
sends.

| Editor | Edits | Open it | Modes |
|---|---|---|---|
| [Terrain editor](terrain.md) | a terrain: its heights, layers, holes, rules, scatter, stack, tiles | double-click a terrain, **Edit terrain** in its Inspector, **GameObject → Terrain** | Sculpt, Paint, Holes, Material rules, Scatter, Stack, Tiles, Settings |
| [Block editor](block-editor.md) | a block layer: its cells, slopes, paint, regions, rooms and buildings, rules | double-click a block layer, **Edit blocks** in its Inspector, **GameObject → Block layer**; a rooms object's **Edit in block editor** | Build, Shape, Paint, Regions, Rooms & buildings, Rules |
| [Vertex paint editor](vertex-paint.md) | a model, instance set, generated architecture or spline: colours and layers painted on its vertices | **Paint vertices** in its Inspector | Paint, Channels, Material |
| [Decal editor](decals.md) | the scene's decals (the whole scene stays drawn; only decals are picked) | **Window → Decals**, or the **decal** button in the tool row | Place, Scatter, Select |

The kit a level is built from is edited in the [kit editor](kit-editor.md),
a tab of the editor window rather than an edit mode: it edits an item, not
the scene. Its settings are panels too.

## Navigate: no tool

Every editor opens with no tool armed: **Navigate**, the lit first tile of
each tool grid.

- A **drag** orbits the view; Shift + drag or a right drag pans; the wheel
  zooms.
- With no tool (**Navigate**), a **click** selects what the editor edits: a
  room, building or path, a block, a decal, a terrain stamp or tile. What a
  click would select is outlined under the pointer; the selection's settings
  open in a panel. With a tool armed, every click is the tool's (the first
  Esc drops the tool, back to Navigate).
- Pick a tool by its tile or its letter. A click on the lit tile drops it
  (back to Navigate). **Space** arms the last tool again; its tile has a
  small *last* mark.
- No tool selects on a click, Rect included: Rect draws, also over a
  building (a room inside it); Polygon, Path and Building place a corner
  with every click, the first one too.
- In Navigate a click on a building selects the building; a
  **double-click** goes in and selects the room or path drawn inside it
  under the pointer (through its walls or roof), and a click there again
  selects the building.
- With a tool armed, Alt + drag orbits.

## Esc

Each press does the first of these that applies:

1. a field you type in: Esc leaves the field;
2. a panel being dragged: the move is cancelled;
3. a stroke or a drawing in progress (a polygon's corners, a drag): cancelled;
4. a tool armed: dropped (Navigate, the selection kept);
5. a selection: cleared;
6. otherwise: the editor is left, as **Done**.

The status line says what the next Esc does (`Esc Deselect`, `Esc Drop the
tool`, `Esc Leave`). **Done**'s Esc badge is dimmed while Esc would do
something else first.

## Panels

The column holds what you pick from: the tool grid, palettes, lists. The
settings of what is picked — the brush and its noise mask, the selection,
the picked stamp or block type, a tool's options — are **panels** over the
view. Each editor's guide lists which are where.

- **Docks.** A panel sits in one of eight docks: the view's four corners
  and four edges. Each side of the view is one column (top corner, edge,
  bottom corner); the top and bottom edges sit between the two columns.
  Panels in a dock stack; they never cover each other.
- **Collapse.** A click on a panel's title bar, or Enter (or Space) on the
  focused title, collapses it to its title bar or opens it. The title bar
  keeps a short summary on its right (a count, on/off, a name). Panels
  collapse but never close.
- **Move.** Drag a title bar: the eight drop targets show; drop it on one
  and the panel goes to the end of that dock's stack. Esc puts it back.
- **Remembered.** Each editor remembers where its panels are and which are
  open, in this browser (not in the project). A panel several modes share
  (Brush) keeps one place.
- **Panels** (the chip on the view's top row) hides or shows them all;
  **Reset layout** beside it puts the editor's panels back where they
  started.
- A click or the wheel on a panel never reaches the view or a tool. A tall
  panel scrolls inside itself when its side of the view runs out of room.

## Framing

- **Home** frames the selection (a building, the selected cells, decals, a
  stamp) or, with nothing selected, the whole object. The camera goes
  outside it, looking down at it, and keeps its heading.
- **F** in the Scene view keeps the distance and turns around the selected
  object; when that would put the camera inside the object (a building's
  walls) it frames the object instead.
- A frame fits the object into the part of the view the open panels leave
  free, so a wide building is never half under a panel. Collapsed panels
  don't count.
- On entering an editor the view is kept when it already shows the object
  from outside and above it. When the camera is inside the object, below
  it, nearly level with the ground or looking away, the editor frames the
  object (the terrain editor: the middle of the terrain, about 64 m
  across).

## While textures load

A new texture on a layered material's layer (on blocks, walls or a model;
**Make it paintable**) takes seconds to encode. Meanwhile the layer
is drawn with stand-ins, each replaced as the next arrives:

1. mid grey, until the colour is known;
2. the texture's average colour, which the backend reads first;
3. a small preview of the texture;
4. the full texture.

So blocks and walls are never white while their textures load; a plain,
flat colour means the texture is still on its way. A texture that cannot
be made keeps its last stand-in, and the reason is in **Problems**.

The decal atlas does the same. When its pages are not made yet (or on
**Rebuild pages**), the decals are drawn from quick **preview pages** (a
quarter of the size, ready in a second or two) and the full pages replace
them in the background. The **Decal
atlas** panel says "Preview in … ms · composing the pages…" meanwhile, and
**Rebuild pages** waits until the full pages are in.

## The keys they share

| Key | Does |
|---|---|
| Shift + `1` … `9` | Switch the rail's mode |
| a letter on a tool tile | Arm that tool (`C`, `F` and `X` are never a tool's letter) |
| `Space` | Arm the last tool again (from Navigate) |
| `1` … `9` | Pick a palette entry (a layer, a block type) by its number |
| `[` / `]` | Smaller / larger brush |
| Shift + `[` / `]` | Less / more strength |
| `F` (Shift + `F`), then move | Resize the brush (its strength) on the surface; a click keeps it, Esc puts it back |
| `X` | Switch the tool and its opposite (paint / erase, raise / lower, cut / fill) |
| `Ctrl` held | The opposite for one stroke |
| drag (Navigate) / Alt + drag (a tool armed) | Orbit the view |
| `Home` | Frame the selection, else the edited object |
| `C` | Context |
| Ctrl + `Z` | Undo |
| `Esc` | The first that applies: leave a field; cancel a panel drag; cancel the stroke or drawing; drop the tool; clear the selection; then **Done** |

The brushes share their settings (size, strength, opacity, falloff,
spacing, the noise mask), their cursor and their sliders: see
[Brushes](brushes.md). The block editor adds **PageUp** / **PageDown** for
its slice and **T** to turn a block.

## Which editor for which job

- The ground of an outdoor level, hills and cliffs: the **terrain editor**.
- Floors, walls, platforms, stairs and anything on a grid, and the rooms
  and buildings drawn on it: the **block editor**
  ([what the engine makes and what you model](../concepts/kits-blocks-and-rooms.md)).
- Moss at a wall's foot, a second material blended into one mesh, a tinted
  prop: the **vertex paint editor**.
- Dirt, cracks, leaks, signs and scorch marks over all of it: the **decal
  editor**.

Related: [Which tool for which job](which-tool.md).
