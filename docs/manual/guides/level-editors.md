# Level editors

**Goal:** know the four editors a level is made in, how to open each, and
the keys they share, so moving from one to the next needs nothing new.

Each is a full-screen **edit mode** on the live Scene view (no second
view): a header naming what you edit with **Done** (Esc), a **rail** of
modes on the left (Shift+1 … Shift+9), the mode's **column** of tools and
settings on the right, and a **status line** at the bottom with the tool,
what to do and its keys. Every editor opens with no tool armed
(**Navigate**, the first tile of each tool grid): a drag orbits the view
and a click selects what the editor edits (a room or building, a block, a
decal, a stamp). Pick a tool by its tile or letter; a click on the armed
tile drops it, and **Space** arms the last tool again. With a drawing tool
armed, a click without a drag on a room or building selects it; a drag
still draws. An object editor shows only that object;
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
the scene.

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
| `Home` | Frame the edited object |
| `C` | Context |
| Ctrl + `Z` | Undo |
| `Esc` | In order: leave a field you type in; cancel the stroke or drawing; clear the selection; drop the tool; then **Done** (its Esc badge dims until Esc would leave) |

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
