# Graph: Animator layer

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Animator layer node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-animator"></a>
## Animator layer

- Graph kind: `animator`
- Stored in: the `animator` documents that own it
- Node budget: 66
- Cycles: allowed

Port types:

| Type | Label |
|---|---|
| `transition` | transition |

<a id="graph-animator--states"></a>
## States

- Entry (`entry`): Where the layer starts: its wire names the first state.
- Any State (`any`): Its transitions may fire from every state of the layer.
- State (`state`): Plays one clip.
- Blend tree (`blend`): Blends clips by a float or int parameter (double-click to open its clips).

<a id="node-animator--entry"></a>
### Entry (`entry`)

Where the layer starts: its wire names the first state.

(every graph needs one; at most 1 per graph; part of every graph, not in the catalogue)

Outputs:

- `out` "start" (transition): one wire

<a id="node-animator--any"></a>
### Any State (`any`)

Its transitions may fire from every state of the layer.

(every graph needs one; at most 1 per graph; part of every graph, not in the catalogue)

Outputs:

- `out` "any" (transition)

<a id="node-animator--state"></a>
### State (`state`)

Plays one clip.

Inputs:

- `in` (transition): takes several wires

Outputs:

- `out` (transition)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `clip` | Clip | string | `""` | ≤ 128 chars |
| `speed` | Speed | number | `1` | 0 – 10 |
| `name` | Name | string | `""` | ≤ 128 chars |
| `loop` | Loop | boolean | `true` |  |
| `speedParameter` | × parameter | string | `""` | ≤ 64 chars |
| `duration` | Length (s) | number | `1` | 0.001 – 600 |
| `asset` | Model asset | string | `""` | ≤ 64 chars |

<a id="node-animator--blend"></a>
### Blend tree (`blend`)

Blends clips by a float or int parameter (double-click to open its clips).

Inputs:

- `in` (transition): takes several wires

Outputs:

- `out` (transition)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `parameter` | Blend by | string | `""` | ≤ 64 chars |
| `speed` | Speed | number | `1` | 0 – 10 |
| `name` | Name | string | `""` | ≤ 128 chars |
| `loop` | Loop | boolean | `true` |  |
| `speedParameter` | × parameter | string | `""` | ≤ 64 chars |
