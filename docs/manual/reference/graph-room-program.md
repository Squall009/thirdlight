# Graph: Room program

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Room program node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-room-program"></a>
## Room program

- Graph kind: `room-program`
- Stored in: standalone graphs (`content.graphs`)
- Node budget: 256
- Cycles: allowed

Port types:

| Type | Label |
|---|---|
| `door` | door |

<a id="graph-room-program--program"></a>
## Program

- Program (`program`): How the footprint is split: walls on a grid from its corner, no room narrower than the smallest side, the doors' size, the room the front door opens into and the type spare space becomes (empty: the first room's).

<a id="node-room-program--program"></a>
### Program (`program`)

How the footprint is split: walls on a grid from its corner, no room narrower than the smallest side, the doors' size, the room the front door opens into and the type spare space becomes (empty: the first room's).

(every graph needs one; at most 1 per graph)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `grid` | Grid | number | `1` | 0.1 – 10 |
| `minSide` | Smallest side | number | `2.4` | 0.5 – 100 |
| `doorWidth` | Door width | number | `1` | 0.3 – 10 |
| `doorHeight` | Door height | number | `2.1` | 0.5 – 10 |
| `entrance` | Entrance room | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
| `filler` | Spare space | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |

<a id="graph-room-program--rooms"></a>
## Rooms

- Room (`room`): A room type: its share of the storey's floor, how many, on which storeys (ground; upper: each storey above it, the ground when there is none; every), whether it holds the stairs (on every storey, in one place) and the preset its inside wears (empty: the building's). Wire two rooms for a door between them.

<a id="node-room-program--room"></a>
### Room (`room`)

A room type: its share of the storey's floor, how many, on which storeys (ground; upper: each storey above it, the ground when there is none; every), whether it holds the stairs (on every storey, in one place) and the preset its inside wears (empty: the building's). Wire two rooms for a door between them.

Inputs:

- `doors` (door): takes several wires

Outputs:

- `door` (door)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | string | `"room"` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}` |
| `area` | Share | number | `1` | 0.01 – 1000 |
| `count` | Count | number | `1` | 0 – 64 |
| `storeys` | Storeys | enum | `"ground"` | `ground`, `upper`, `every` |
| `stairs` | Holds the stairs | boolean | `false` |  |
| `preset` | Inside preset | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
