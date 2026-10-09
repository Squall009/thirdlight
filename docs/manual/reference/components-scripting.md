# Components: Scripting

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Scripting components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-behavior"></a>
## behavior — Script

Runs a published behavior (script) on this object with per-object property values.

- Category: Scripting
- Added: from "+ Add component" after picking `behaviorId` (the rest starts as `{"values":{}}`)
- On prefab objects: yes

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `behaviorId` | behavior id |  |  | **Behavior.** The published behavior. (required; scripts read) |
| `values` | map identifier → JSON (typed by behaviorDeclaration) | `{}` |  | **Properties.** Values for the behavior's declared properties (absent: the declared default). (required; scripts read) |

<a id="component-behaviorGroup"></a>
## behaviorGroup — Behavior group

The group this object's behavior belongs to. A game mode lists the groups that tick while it is active; the others pause (their scripts do not run).

- Category: Scripting
- Added: from "+ Add component" after picking `group` (the rest starts as `{}`)
- On prefab objects: yes

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `group` | behaviorGroup id |  |  | **Group.** One of the project's behavior groups (Game modes panel). (required; scripts read) |
