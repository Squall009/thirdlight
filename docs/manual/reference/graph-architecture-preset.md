# Graph: Architecture preset

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Architecture preset node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-architecture-preset"></a>
## Architecture preset

- Graph kind: `architecture-preset`
- Stored in: standalone graphs (`content.graphs`)
- Node budget: 512
- Cycles: refused

Port types:

| Type | Label |
|---|---|
| `number` | number |

<a id="graph-architecture-preset--preset"></a>
## Preset

- Preset (`preset`): The style it sets values for (empty: its base's), the preset it derives from, and the trim sheet material it wears (empty: its base's, else the object's).

<a id="node-architecture-preset--preset"></a>
### Preset (`preset`)

The style it sets values for (empty: its base's), the preset it derives from, and the trim sheet material it wears (empty: its base's, else the object's).

(every graph needs one; at most 1 per graph)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `style` | Style | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
| `base` | Derives from | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
| `sheet` | Trim sheet | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |

<a id="graph-architecture-preset--values"></a>
## Values

- Value (`value`): A parameter's value (over its base's and the style's default).
- Mask (`mask`): Drives a parameter by a world mask read at each outline's middle: from its value where the mask is 0 to `to` where it is 1. The mask is world noise, the outline's height, or a mask painted on the object; it is 0 at `low` and 1 at `high`.

<a id="node-architecture-preset--value"></a>
### Value (`value`)

A parameter's value (over its base's and the style's default).

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `parameter` | Parameter | string | `"value"` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}` |
| `value` | Value | number | `0` | -100000 – 100000 |

<a id="node-architecture-preset--mask"></a>
### Mask (`mask`)

Drives a parameter by a world mask read at each outline's middle: from its value where the mask is 0 to `to` where it is 1. The mask is world noise, the outline's height, or a mask painted on the object; it is 0 at `low` and 1 at `high`.

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `parameter` | Parameter | string | `"value"` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}` |
| `to` | To | number | `1` | -100000 – 100000 |
| `source` | Source | enum | `"noise"` | `noise`, `height`, `painted` |
| `mask` | Painted mask | string | `""` | ≤ 64 chars; matches `\|[a-z0-9][a-z0-9_-]{0,63}` |
| `scale` | Noise scale | number | `20` | 0.01 – 100000 |
| `seed` | Noise seed | number | `0` | 0 – 4294967295 |
| `low` | Low | number | `0` | -100000 – 100000 |
| `high` | High | number | `1` | -100000 – 100000 |
