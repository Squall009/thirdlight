# Graph: Furnishing set

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Furnishing set node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-furnishing-set"></a>
## Furnishing set

- Graph kind: `furnishing-set`
- Stored in: standalone graphs (`content.graphs`)
- Node budget: 256
- Cycles: refused

Port types:

<a id="graph-furnishing-set--furnishing"></a>
## Furnishing

- Furnishing (`furnishing`): Kept free: metres in front of each door, and a walkable path this wide joining a room's doors and stairs. The gap between a prop and its wall, and the most lights one building gets (largest rooms first).

<a id="node-furnishing-set--furnishing"></a>
### Furnishing (`furnishing`)

Kept free: metres in front of each door, and a walkable path this wide joining a room's doors and stairs. The gap between a prop and its wall, and the most lights one building gets (largest rooms first).

(every graph needs one; at most 1 per graph)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `doorClearance` | Door clearance | number | `1` | 0 – 10 |
| `pathWidth` | Path width | number | `0.8` | 0 – 10 |
| `wallGap` | Wall gap | number | `0.02` | 0 – 1 |
| `lights` | Lights | number | `4` | 0 – 16 |

<a id="graph-furnishing-set--props"></a>
## Props

- Prop (`prop`): A kit model placed in rooms of a type (empty: any room): its back against a wall facing the room, in a corner, or in the middle facing the door; its footprint (width along its X, depth along its Z, metres), height (not in front of windows above it), how many, and the space kept round it.
- Light (`light`): A point light in the middle of each room of a type (empty: any room), this high over its floor.

<a id="node-furnishing-set--prop"></a>
### Prop (`prop`)

A kit model placed in rooms of a type (empty: any room): its back against a wall facing the room, in a corner, or in the middle facing the door; its footprint (width along its X, depth along its Z, metres), height (not in front of windows above it), how many, and the space kept round it.

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `room` | Room type | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
| `model` | Model | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}`; a model asset |
| `piece` | Piece | string | `""` | ≤ 128 chars |
| `place` | Place | enum | `"wall"` | `wall`, `corner`, `centre` |
| `width` | Width | number | `1` | 0.05 – 1000 |
| `depth` | Depth | number | `0.6` | 0.05 – 1000 |
| `height` | Height | number | `1` | 0.01 – 1000 |
| `count` | Count | number | `1` | 0 – 64 |
| `spacing` | Space round it | number | `0.2` | 0 – 10 |

<a id="node-furnishing-set--light"></a>
### Light (`light`)

A point light in the middle of each room of a type (empty: any room), this high over its floor.

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `room` | Room type | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
| `color` | Colour | color | `"#ffe2b8"` |  |
| `intensity` | Intensity | number | `1.5` | 0 – 8 |
| `range` | Range | number | `6` | 0 – 1000 |
| `height` | Height | number | `2.2` | 0 – 1000 |
