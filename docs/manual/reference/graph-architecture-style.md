# Graph: Architecture style

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Architecture style node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-architecture-style"></a>
## Architecture style

- Graph kind: `architecture-style`
- Stored in: standalone graphs (`content.graphs`)
- Node budget: 512
- Cycles: refused
- Results: `output` (a node reaching none gets a warning)

Port types:

| Type | Label |
|---|---|
| `number` | number |
| `path` | path |
| `profile` | profile |
| `element` | element |

<a id="graph-architecture-style--inputs"></a>
## Inputs

- Outline (`outline`): The outline the style is drawn on (a room's or a run's path).
- Parameter (`parameter`): An exposed slider: presets set its value, masks vary it across the level.
- Constant (`constant`)

<a id="node-architecture-style--outline"></a>
### Outline (`outline`)

The outline the style is drawn on (a room's or a run's path).

Outputs:

- `path` (path)

<a id="node-architecture-style--parameter"></a>
### Parameter (`parameter`)

An exposed slider: presets set its value, masks vary it across the level.

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `"value"` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}` |
| `default` | Default | number | `1` | -100000 – 100000 |
| `min` | Min | number | `0` | -100000 – 100000 |
| `max` | Max | number | `10` | -100000 – 100000 |

<a id="node-architecture-style--constant"></a>
### Constant (`constant`)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | Value | number | `0` | -100000 – 100000 |

<a id="graph-architecture-style--math"></a>
## Math

- Add (`add`)
- Multiply (`multiply`)
- Mix (`mix`): a to b by t.

<a id="node-architecture-style--add"></a>
### Add (`add`)

Inputs:

- `a` (number)
- `b` (number)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -100000 – 100000 |
| `b` | b | number | `0` | -100000 – 100000 |

<a id="node-architecture-style--multiply"></a>
### Multiply (`multiply`)

Inputs:

- `a` (number)
- `b` (number)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `1` | -100000 – 100000 |
| `b` | b | number | `1` | -100000 – 100000 |

<a id="node-architecture-style--mix"></a>
### Mix (`mix`)

a to b by t.

Inputs:

- `a` (number)
- `b` (number)
- `t` (number)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -100000 – 100000 |
| `b` | b | number | `1` | -100000 – 100000 |
| `t` | t | number | `0.5` | 0 – 1 |

<a id="graph-architecture-style--paths"></a>
## Paths

- Offset (`offset`): Moves the path to the right of travel (inside a room drawn clockwise), corners mitred.
- Raise (`raise`): Lifts the path (a ceiling, a vault's springing).
- Chamfer (`chamfer`): Cuts each sharp corner of the path.
- Square (`square`): A closed square round a repeated piece's middle (its own frame), inside on the right.

<a id="node-architecture-style--offset"></a>
### Offset (`offset`)

Moves the path to the right of travel (inside a room drawn clockwise), corners mitred.

Inputs:

- `path` (path): required
- `distance` "Distance" (number)

Outputs:

- `path` (path)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `distance` | Distance | number | `0` | -1000 – 1000 |

<a id="node-architecture-style--raise"></a>
### Raise (`raise`)

Lifts the path (a ceiling, a vault's springing).

Inputs:

- `path` (path): required
- `height` "Height" (number)

Outputs:

- `path` (path)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `height` | Height | number | `0` | -1000 – 1000 |

<a id="node-architecture-style--chamfer"></a>
### Chamfer (`chamfer`)

Cuts each sharp corner of the path.

Inputs:

- `path` (path): required
- `size` "Size" (number)

Outputs:

- `path` (path)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `size` | Size | number | `0` | 0 – 1000 |

<a id="node-architecture-style--square"></a>
### Square (`square`)

A closed square round a repeated piece's middle (its own frame), inside on the right.

Inputs:

- `size` "Size" (number)

Outputs:

- `path` (path)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `size` | Size | number | `0.3` | 0.05 – 1000 |

<a id="graph-architecture-style--profiles"></a>
## Profiles

- Wall profile (`wall`): A wall centred on its path: the inside face (right of travel), its top, the outside face; below the dado both faces wear the lower slot.
- Band profile (`band`): A flat band standing out of a face right of travel: a baseboard, a dado rail, a string course (0 depth or height: none).
- Cove profile (`cove`): A cove moulding under a ceiling on a face right of travel (0 depth or size: none).
- Shaft profile (`shaft`): A column's face, swept round a square.
- Frame profile (`frame`): A flat frame round an opening.
- Round profile (`round`): A closed round section centred on its path, lifted by its height: a pipe, a rail, a cable (its ends capped).

<a id="node-architecture-style--wall"></a>
### Wall profile (`wall`)

A wall centred on its path: the inside face (right of travel), its top, the outside face; below the dado both faces wear the lower slot.

Inputs:

- `thickness` "Thickness" (number)
- `height` "Height" (number)
- `dado` "Dado" (number)
- `chamfer` "Chamfer" (number)

Outputs:

- `profile` (profile)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `thickness` | Thickness | number | `0.2` | 0.01 – 10 |
| `height` | Height | number | `3` | 0.05 – 1000 |
| `dado` | Dado | number | `0` | 0 – 1000 |
| `chamfer` | Chamfer | number | `0` | 0 – 1 |
| `inside` | Inside | string | `"upper_wall"` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
| `outside` | Outside | string | `"upper_wall"` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
| `lower` | Lower | string | `"lower_wall"` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
| `top` | Top | string | `"bevel"` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |

<a id="node-architecture-style--band"></a>
### Band profile (`band`)

A flat band standing out of a face right of travel: a baseboard, a dado rail, a string course (0 depth or height: none).

Inputs:

- `height` "Height" (number)
- `depth` "Depth" (number)
- `base` "Base" (number)

Outputs:

- `profile` (profile)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `height` | Height | number | `0.15` | 0 – 1000 |
| `depth` | Depth | number | `0.03` | 0 – 10 |
| `base` | Base | number | `0` | -1000 – 1000 |
| `slot` | Slot | string | `"baseboard"` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |

<a id="node-architecture-style--cove"></a>
### Cove profile (`cove`)

A cove moulding under a ceiling on a face right of travel (0 depth or size: none).

Inputs:

- `size` "Size" (number)
- `depth` "Depth" (number)
- `top` "Top" (number)

Outputs:

- `profile` (profile)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `size` | Size | number | `0.4` | 0 – 10 |
| `depth` | Depth | number | `0.1` | 0 – 10 |
| `top` | Top | number | `3` | -1000 – 1000 |
| `slot` | Slot | string | `"crown"` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |

<a id="node-architecture-style--shaft"></a>
### Shaft profile (`shaft`)

A column's face, swept round a square.

Inputs:

- `height` "Height" (number)

Outputs:

- `profile` (profile)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `height` | Height | number | `2.5` | 0.05 – 1000 |
| `slot` | Slot | string | `"column"` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |

<a id="node-architecture-style--frame"></a>
### Frame profile (`frame`)

A flat frame round an opening.

Inputs:

- `width` "Width" (number)
- `depth` "Depth" (number)

Outputs:

- `profile` (profile)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `width` | Width | number | `0.12` | 0.01 – 10 |
| `depth` | Depth | number | `0.04` | 0.001 – 10 |
| `slot` | Slot | string | `"frame"` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |

<a id="node-architecture-style--round"></a>
### Round profile (`round`)

A closed round section centred on its path, lifted by its height: a pipe, a rail, a cable (its ends capped).

Inputs:

- `radius` "Radius" (number)
- `height` "Height" (number)
- `sides` "Sides" (number)

Outputs:

- `profile` (profile)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `radius` | Radius | number | `0.05` | 0.005 – 10 |
| `height` | Height | number | `0` | -1000 – 1000 |
| `sides` | Sides | number | `8` | 3 – 32 |
| `slot` | Slot | string | `"column"` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |

<a id="graph-architecture-style--elements"></a>
## Elements

- Sweep (`sweep`): A profile swept along a path, mitred at corners; with Openings on it cuts the outline's doors and windows (framed with the frame profile). A room's Wall is made once where rooms share it, each side dressed by its own room.
- Repeat (`repeat`): Pieces (sweeps and fills in the copy's own frame) stamped along a path.
- Fill (`fill`): A closed path filled: a floor or ceiling, coffers, a vault or a roof (rise 0: the shape's own).

<a id="node-architecture-style--sweep"></a>
### Sweep (`sweep`)

A profile swept along a path, mitred at corners; with Openings on it cuts the outline's doors and windows (framed with the frame profile). A room's Wall is made once where rooms share it, each side dressed by its own room.

Inputs:

- `path` (path): required
- `profile` (profile): required
- `frame` (profile)

Outputs:

- `element` (element)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `openings` | Openings | boolean | `false` |  |
| `wall` | Wall | boolean | `false` |  |
| `detail` | Detail | boolean | `false` |  |
| `collide` | Collide | enum | `"auto"` | `auto`, `yes`, `no` |
| `material` | Material slot | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |

<a id="node-architecture-style--repeat"></a>
### Repeat (`repeat`)

Pieces (sweeps and fills in the copy's own frame) stamped along a path.

Inputs:

- `path` (path): required
- `piece` (element): required, takes several wires
- `spacing` "Spacing" (number)
- `start` "Start" (number)
- `jitterYaw` "Jitter turn" (number)
- `jitterAlong` "Jitter along" (number)

Outputs:

- `element` (element)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `spacing` | Spacing | number | `2` | 0.05 – 1000 |
| `start` | Start | number | `0` | 0 – 100000 |
| `jitterYaw` | Jitter turn | number | `0` | 0 – 180 |
| `jitterAlong` | Jitter along | number | `0` | 0 – 1000 |
| `corners` | At corners | boolean | `false` |  |
| `align` | Face along | boolean | `true` |  |
| `detail` | Detail | boolean | `false` |  |
| `collide` | Collide | enum | `"auto"` | `auto`, `yes`, `no` |
| `material` | Material slot | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |

<a id="node-architecture-style--fill"></a>
### Fill (`fill`)

A closed path filled: a floor or ceiling, coffers, a vault or a roof (rise 0: the shape's own).

Inputs:

- `path` (path): required
- `height` "Height" (number)
- `rise` "Rise" (number)
- `cell` "Cell" (number)
- `depth` "Depth" (number)
- `overhang` "Overhang" (number)

Outputs:

- `element` (element)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `height` | Height | number | `0` | -1000 – 1000 |
| `rise` | Rise | number | `0` | 0 – 1000 |
| `cell` | Cell | number | `1.5` | 0.2 – 1000 |
| `depth` | Depth | number | `0.2` | 0 – 1000 |
| `overhang` | Overhang | number | `0` | 0 – 1000 |
| `shape` | Shape | enum | `"flat"` | `flat`, `coffered`, `barrel`, `groin`, `gable`, `hip`, `mansard` |
| `slot` | Slot | string | `"floor"` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
| `trimSlot` | Trim slot | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
| `face` | Faces | enum | `"auto"` | `auto`, `up`, `down` |
| `axis` | Axis | enum | `"long"` | `long`, `short` |
| `detail` | Detail | boolean | `false` |  |
| `collide` | Collide | enum | `"auto"` | `auto`, `yes`, `no` |
| `material` | Material slot | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |

<a id="graph-architecture-style--output"></a>
## Output

- Output (`output`): What the style makes.

<a id="node-architecture-style--output"></a>
### Output (`output`)

What the style makes.

(every graph needs one; at most 1 per graph)

Inputs:

- `elements` (element): required, takes several wires
