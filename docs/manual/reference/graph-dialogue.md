# Graph: Dialogue

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Dialogue node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-dialogue"></a>
## Dialogue

- Graph kind: `dialogue`
- Stored in: the `dialogue` documents that own it
- Node budget: 1024
- Cycles: allowed

Port types:

| Type | Label |
|---|---|
| `flow` | next |
| `option` | option |

<a id="graph-dialogue--flow"></a>
## Flow

- Start (`start`): Where the conversation starts.
- Entry (`entry`): A named place to start or jump to (ctx.dialogue.start(id, {entry})).
- Jump (`jump`): Continues in another conversation (its start, or a named entry).
- End (`end`): Ends the conversation (a node with nothing next ends it too).

<a id="node-dialogue--start"></a>
### Start (`start`)

Where the conversation starts.

(every graph needs one; at most 1 per graph; part of every graph, not in the catalogue)

Outputs:

- `next` (flow): one wire

<a id="node-dialogue--entry"></a>
### Entry (`entry`)

A named place to start or jump to (ctx.dialogue.start(id, {entry})).

Outputs:

- `next` (flow): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `"entry"` | ≤ 32 chars; matches `[A-Za-z_][A-Za-z0-9_]*` |

<a id="node-dialogue--jump"></a>
### Jump (`jump`)

Continues in another conversation (its start, or a named entry).

Inputs:

- `in` (flow): takes several wires

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `dialogue` | Dialogue | string | `""` | ≤ 64 chars |
| `entry` | Entry | string | `""` | ≤ 32 chars |

<a id="node-dialogue--end"></a>
### End (`end`)

Ends the conversation (a node with nothing next ends it too).

Inputs:

- `in` (flow): takes several wires

<a id="graph-dialogue--lines"></a>
## Lines

- Line (`line`): A speaker says a line (its text is the subtitle); its voice clip plays on the voice bus.
- Choice (`choice`): The player picks one of the options wired to it (top to bottom); "none" when no option is available.
- Option (`option`): One option of a choice: shown when its condition holds (and, with once, until picked); picking it applies its effects.

<a id="node-dialogue--line"></a>
### Line (`line`)

A speaker says a line (its text is the subtitle); its voice clip plays on the voice bus.

Inputs:

- `in` (flow): takes several wires

Outputs:

- `next` (flow): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `speaker` | Speaker | string | `""` | ≤ 64 chars |
| `expression` | Expression | string | `""` | ≤ 32 chars |
| `text` | Text | string | `""` | ≤ 1024 chars |
| `voice` | Voice clip | string | `""` | ≤ 64 chars; a voice asset |
| `auto` | Auto-advance | enum | `"default"` | `default`, `on`, `off` |

<a id="node-dialogue--choice"></a>
### Choice (`choice`)

The player picks one of the options wired to it (top to bottom); "none" when no option is available.

Inputs:

- `in` (flow): takes several wires

Outputs:

- `options` (option)
- `none` (flow): one wire

<a id="node-dialogue--option"></a>
### Option (`option`)

One option of a choice: shown when its condition holds (and, with once, until picked); picking it applies its effects.

Inputs:

- `in` "choice" (option): required

Outputs:

- `next` (flow): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `text` | Text | string | `""` | ≤ 256 chars |
| `condition` | Condition | string | `""` | ≤ 512 chars |
| `effects` | Effects | string | `""` | ≤ 512 chars |
| `once` | Once | boolean | `false` |  |

<a id="graph-dialogue--logic"></a>
## Logic

- Branch (`branch`): Goes on by "true" when the condition holds, else by "false".
- Set (`set`): Changes dialogue variables: "name = value; count += 1".

<a id="node-dialogue--branch"></a>
### Branch (`branch`)

Goes on by "true" when the condition holds, else by "false".

Inputs:

- `in` (flow): takes several wires

Outputs:

- `true` (flow): one wire
- `false` (flow): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `condition` | Condition | string | `""` | ≤ 512 chars |

<a id="node-dialogue--set"></a>
### Set (`set`)

Changes dialogue variables: "name = value; count += 1".

Inputs:

- `in` (flow): takes several wires

Outputs:

- `next` (flow): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `effects` | Effects | string | `""` | ≤ 512 chars |

<a id="graph-dialogue--events"></a>
## Events

- Signal (`signal`): Raises an event scripts and timelines see; with Wait the conversation holds until ctx.dialogue.resume().
- Wait (`wait`): Holds the conversation for some seconds (the dialogue box stays as it is).

<a id="node-dialogue--signal"></a>
### Signal (`signal`)

Raises an event scripts and timelines see; with Wait the conversation holds until ctx.dialogue.resume().

Inputs:

- `in` (flow): takes several wires

Outputs:

- `next` (flow): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `"signal"` | ≤ 64 chars; matches `[A-Za-z_][A-Za-z0-9_.:-]*` |
| `value` | Value | string | `""` | ≤ 256 chars |
| `wait` | Wait | boolean | `false` |  |

<a id="node-dialogue--wait"></a>
### Wait (`wait`)

Holds the conversation for some seconds (the dialogue box stays as it is).

Inputs:

- `in` (flow): takes several wires

Outputs:

- `next` (flow): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `seconds` | Seconds | number | `1` | 0 – 600 |
