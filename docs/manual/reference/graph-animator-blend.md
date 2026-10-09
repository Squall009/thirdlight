# Graph: Blend tree

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Blend tree node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-animator-blend"></a>
## Blend tree

- Graph kind: `animator-blend`
- Stored in: the `animator` documents that own it
- Node budget: 17
- Cycles: refused

Port types:

| Type | Label |
|---|---|
| `motion` | motion |

<a id="graph-animator-blend--blend"></a>
## Blend

- Blend (`output`): The blend tree: every clip feeds it, weighted by the parameter.
- Clip (`clip`): A clip played at its threshold of the blend parameter.

<a id="node-animator-blend--output"></a>
### Blend (`output`)

The blend tree: every clip feeds it, weighted by the parameter.

(every graph needs one; at most 1 per graph; part of every graph, not in the catalogue)

Inputs:

- `motions` "clips" (motion): takes several wires

<a id="node-animator-blend--clip"></a>
### Clip (`clip`)

A clip played at its threshold of the blend parameter.

Outputs:

- `motion` (motion)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `threshold` | Threshold | number | `0` | -1000000 – 1000000 |
| `clip` | Clip | string | `""` | ≤ 128 chars |
| `duration` | Length (s) | number | `1` | 0.001 – 600 |
| `asset` | Model asset | string | `""` | ≤ 64 chars |
| `speed` | Ground speed (m/s) | number | `-1` | -1 – 1000 |
