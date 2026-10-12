# Brushes: settings, cursor and keys

**Goal:** know what every brush setting does and the keys that change it.
Every brush in an edit mode (the [terrain editor](terrain.md) today) uses
the same settings, the same cursor and the same keys, so what you learn in
one editor works in the next. The vertex paint, instance and block brushes
still have panels of their own ([vertex paint](vertex-paint.md),
[instance sets](instance-sets.md), [block layers](block-layers.md)).

## The settings

The **Brush** section of a tool's column shows the settings that tool uses;
a tool that has no use for one leaves it out.

| Setting | What it does |
|---|---|
| **Height step** (sculpt tools) | Metres one dab at full strength moves the ground. |
| **Size** | Metres across the brush (the cursor's outer ring). A stamp or an erosion square is this wide. |
| **Strength** | How much one dab does (0–100 %). A long drag adds dab after dab. |
| **Opacity** (paint tools) | The most one stroke paints, however long you drag: at 50 % a layer never covers more than half, until you let go and paint again. |
| **Falloff** | How the dab fades toward its edge: **Smooth**, **Linear**, **Constant** (full strength to the edge) or **Curve** (full strength out to its **Hardness**, then smooth). |
| **Spacing** | The distance between dabs along a stroke, as a share of the size. |
| **Invert** | The tool's opposite for every stroke: lower instead of raise, erase instead of paint, fill instead of cut. The toggle names it in plain words. |
| **Noise mask** | **Paint through noise**: each dab is multiplied by a noise pattern, so paint and sculpting come out broken up rather than as round blobs. **Scale** (metres of one blob), **Contrast**, **Threshold** (how much is left out), **Octaves** (finer detail on top) and **Seed**. The swatch beside it shows the pattern one brush wide. The noise is fixed to the terrain, not the brush: strokes that overlap, and strokes across a tile edge, line up without a seam. |

Each tool remembers its own settings in this browser (not in the project):
a sculpt brush and a paint brush keep their sizes apart. Invert is never
remembered, so a reload never leaves a brush erasing.

## The cursor

Over the object the cursor shows the brush where it will land, laid on the
surface:

- the **outer ring** is the size;
- the **dashed inner ring** is where the falloff is at half strength;
- the **fill** shows the strength (and the noise mask, when it is on);
- it is the brush's amber when painting and **red** when it inverts
  (X, or Ctrl held).

The status line at the bottom of the editor names the tool, says what to
do and lists the keys it takes.

## The keys

| Key | Does |
|---|---|
| `[` / `]` | Smaller / larger brush |
| `Shift` + `[` / `]` | Less / more strength |
| `F`, then move | Resize on the surface: the size follows the pointer; a click keeps it, **Esc** puts it back |
| `Shift` + `F`, then move | The same for the strength |
| `X` | Switch the tool and its opposite (paint / erase, raise / lower, cut / fill) |
| `Ctrl` held | The opposite for one stroke |
| `1` … `9` | Pick a palette entry (a paint layer) by its number |
| a letter on a tool tile | Pick that tool (`Q`, `W`, `E`, … in the order of the grid) |
| `Esc` | Cancel the stroke or drag in progress; with none, close a popover; then leave the editor |

The keys of every edit mode:

| Key | Does |
|---|---|
| `Shift` + `1` … `9` | Switch the rail's mode |
| `Alt` + drag | Orbit the view (a plain drag paints) |
| `Home` | Frame the edited object |
| `C` | **Context**: show the rest of the scene around it (it cannot be picked) |
| `Ctrl` + `Z` | Undo (one stroke is one step) |
| `Esc` | **Done** |

`[`, `]`, `F` and `X` are read by their place on the keyboard, so they
work on any layout. `C`, `F` and `X` are never a tool's letter.

## From scripts and MCP

The settings are arguments of the edit commands, so a build script or an
agent paints the same strokes: `radius` (half the size), `strength`,
`opacity`, `falloff` and `hardness`, `erase`, and `mask`
(`{scale, contrast, threshold, octaves, seed}`). See
[`editTerrain`](../reference/ops-detail.md#op-editTerrain); vertex paint and
block paint take the same `opacity` and `mask`.
