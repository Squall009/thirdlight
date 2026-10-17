# Vertex paint

**Goal:** moss creeping up a wall's foot, a second trim sheet blended into
a façade, a wet patch, a tinted prop — painted straight onto the meshes in
the vertex paint editor. The full description is in
[Vertex paint](../features/vertex-paint.md).

## Open the editor

Select a placed model, an instance set, generated architecture or a spline,
then **Paint vertices** in the Inspector. The vertex paint editor takes the
work area over, as the [terrain editor](terrain.md) does:

- the header names the object (**Done** or Esc goes back, the selection
  as before); undo and redo are the project's one history;
- the Scene view shows **only that object** (**Context**, `C`, shows the
  rest of the scene too, not paintable);
- the rail on the left has three modes: **Paint**, **Channels** and
  **Material** (`Shift+1…3`);
- the column on the right holds what you pick from, panels over the view
  the brush and the views (below); it opens in **Navigate** (no tool), where
  a drag orbits;
- the status line at the bottom says what to do and lists the keys.

| Mode | Column | Panels (where they start) |
|---|---|---|
| **Paint** | the banner when the material reads no paint, Material (its card), Tool, Layers | **Brush** (right edge) · **Noise mask** (open while it is on) · **Channel view** (top left; `V` cycles it) |
| **Channels** | Channel view (the list) | **What the channels mean** (right edge, open) · **Stored paint** (collapsed) |
| **Material** | Material, Layers | none |

How panels collapse, move and reset, Esc and Home: [Level editors](level-editors.md).

A double-click on a model does not open it (every model can be painted, so
a double-click keeps renaming in the Hierarchy and picking in the Scene
view).

## What the paint means: the palette

The **Layers** palette in Paint shows what the paint does on the object's
material, read from the material itself:

| The material | The tiles | The channels |
|---|---|---|
| a **Layered surface** | **Base**, layers 2–4 (named and pictured as in the material), **Wet** | R, G, B = layers 2–4, A = wetness; the base is what R, G and B leave |
| a **Trim sheet** material | **Grime**, **Wetness** | G = grime, B = wetness (as before) |
| a **Standard** material with *Paint tint* | **Tint red / green / blue**, **Tint amount** | RGB = the tint, A = how much (A alone darkens) |
| a graph that reads the paint otherwise | **Paint R / G / B / A** | as its Vertex colour (paint) node reads them |

Pick a tile with a click or its number key (`1…5`). Painting a layer
raises it; **Erase** (`X`) takes it off. Painting the **Base** takes layers
2–4 off at once (one stroke, one undo step).

### When the material doesn't read paint

A material that reads no paint (a plain Standard material, a model's own
materials) would show nothing you paint. The editor says so — a banner in
the column, a note over the view, a grey cursor — and painting is off.
**Make it paintable** swaps in a Layered surface whose **base keeps the old
material's textures** (its colour, normal and ORM maps; a trim sheet's base
follows the sheet, strips and rows), assigned in the same command: one undo
step puts the old material back. Then give layers 2–4 their textures in
**Material**.

A trim sheet or tint material reads paint its own way; **Material → Make it
a layered surface** does the same swap when you want layers of other
materials on it.

## Paint

1. In **Paint**, pick the tool (**Paint** `B` or **Erase** `X`) and a tile.
2. Set the brush in the **Brush** panel on the view's right edge — the same
   panel as every brush ([Brushes](brushes.md)): **Size** (metres across), **Strength** (one
   dab), **Opacity** (the most one stroke reaches), **Falloff**,
   **Spacing**, and **Paint through noise** for broken edges (moss, rust).
3. Drag on the object. The cursor lies flat on the face under the pointer;
   the paint shows as you drag; the release stores the stroke — one undo
   step.
   - On an instance set, the drag paints the copy it starts on, and only
     that copy.
   - On generated architecture, it paints the path nearest where it starts
     (an outline, a building, a swept element) on the side the face looks
     to; the paint stays put when the wall is made again (a new door,
     another storey, another preset).

Keys: `[` / `]` size, `Shift+[` / `Shift+]` strength, `F` then drag to
resize in the view (`Shift+F`: strength), `Ctrl` held erases one stroke,
Alt+drag orbits, `Home` frames the object, Esc drops a stroke in progress.

## Channels

**Channels** shows one channel of the paint as grey over the view (white:
full, black: none) — for paint a material shows only faintly (wetness,
grime, a soft blend). In Paint the same list is the **Channel view** panel
at the top left of the view; `V` cycles it. The panels **What the channels
mean** (R, G, B and A on the material) and **Stored paint** (what the object
keeps painted) sit on the view's right edge.

## Material

**Material** shows the material card and, on a layered surface, its layers:
drop or pick a texture into each layer (its normal and ORM maps come along
when named alike), and **Layer settings…** for a layer's name, tiling, UV
source and trim sheet (see [Material graphs](material-graphs.md) and
[Height in alpha](height-in-alpha.md) for the textures a layer wants).

## Over MCP

The same stroke is one `paintVertices` command (`tl_command`): the object,
the dabs (world points) and the brush — `channel`, plus `channels` for more
painted alike (the base: `channel` 0 with `channels` [1, 2] and `erase`);
`copy` for a copy, `path` and `side` for generated objects. See the feature
page for the arguments.

## Good to know

- Paint lands on vertices: a mesh with few vertices takes soft paint (a
  generated wall has a vertex about every metre along). Use a decal for a
  sharp mark.
- A reimport that changes a painted mesh leaves its paint undrawn and
  reported (`paint_mismatch` in Problems). A stroke over it is refused; the
  editor offers **Remove its stale paint** (Paint and Channels), then paint
  again.
- Painted copies stay in their instanced draw, and painted static objects
  stay merged: painting adds no draws.
- The brush settings are remembered per browser, the picked tile per object
  while the page is open.
