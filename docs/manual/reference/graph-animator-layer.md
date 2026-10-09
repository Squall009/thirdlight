# Graph: Animator override layer

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Animator override layer node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-animator-layer"></a>
## Animator override layer

- Graph kind: `animator-layer`
- Stored in: the `animator` documents that own it
- Node budget: 66
- Cycles: allowed

Port types:

| Type | Label |
|---|---|
| `transition` | transition |

<a id="graph-animator-layer--states"></a>
## States

- [Entry](graph-animator.md#node-animator--entry) (`entry`, as in `animator`): Where the layer starts: its wire names the first state.
- [Any State](graph-animator.md#node-animator--any) (`any`, as in `animator`): Its transitions may fire from every state of the layer.
- [State](graph-animator.md#node-animator--state) (`state`, as in `animator`): Plays one clip.
- [Blend tree](graph-animator.md#node-animator--blend) (`blend`, as in `animator`): Blends clips by a float or int parameter (double-click to open its clips).
- Empty state (`empty`): Plays nothing: the layers under this one show through.

<a id="node-animator-layer--empty"></a>
### Empty state (`empty`)

Plays nothing: the layers under this one show through.

Inputs:

- `in` (transition): takes several wires

Outputs:

- `out` (transition)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `speed` | Speed | number | `1` | 0 – 10 |
| `name` | Name | string | `""` | ≤ 128 chars |
| `loop` | Loop | boolean | `true` |  |
| `speedParameter` | × parameter | string | `""` | ≤ 64 chars |
