# Visual scripts

**Goal:** a visual script on the player that counts jumps: an **On input**
event for the `jump` action adds a public variable's value to a counter.
Every node and setting: [Visual scripts](../features/visual-scripts.md);
every node's ports and fields: [Visual script nodes](../reference/graph-behavior-1.md).

A visual script is a node graph that the backend compiles to the same kind
of script as TypeScript: same compiler, same trust, same Play and export.

## In the editor

1. **File → Project Settings… → Scripts**: type `Jump counter` next to
   **+ Visual script** and press it. The script opens as a **Graph** tab
   with an **On start** node.
2. **+ Variable** on the left: name `per_jump`, type Number, visibility
   public, default 1. Public variables are the script's properties.
3. Right-click the graph (or Space, or **+ Node**) and add **On input**;
   in the Inspector set **Action** to `jump` and **When** to pressed. Add
   **Add to counter** and set its counter to `jumps`.
4. Drag from On input's exec output (the thick white wire) to Add to
   counter's exec input. Drag `per_jump` from the variable list onto the
   graph, pick **Get**, and wire its value into **amount**.
5. Problems show on their node and beside the graph. **Publish** (the
   trust notice asks once for a new digest).
6. Select the player, **+ Add component → Script**, pick the script, set
   **Per jump** to 2. **▶ play** and jump.

While Play runs, the tab's **Debug (Play)** panel lights the nodes that ran,
shows wire values on hover and stops at breakpoints (**F9** on a node).

## Through the API

1. Create the script with its graph ([`publishBehavior`](../reference/ops-detail.md#op-publishBehavior),
   [`GraphData`](../reference/types-d-p.md#type-graph-data)):
   ```json
   {"behaviorId": "jumpcount", "displayName": "Jump counter", "mode": "declaration-create",
    "declaration": {"properties": []},
    "graph": {"nodes": [
      {"id": "var", "type": "var.number", "position": [0, 0], "data": {"name": "per_jump", "default": 1, "visibility": "public"}},
      {"id": "on", "type": "event.input", "position": [0, 120], "data": {"action": "jump", "when": "pressed"}},
      {"id": "get", "type": "var.get", "position": [0, 260], "data": {"variable": "per_jump"}},
      {"id": "add", "type": "api.game.add", "position": [260, 120], "data": {"name": "jumps"}}
    ], "edges": [
      {"id": "e1", "from": {"node": "on", "port": "then"}, "to": {"node": "add", "port": "in"}},
      {"id": "e2", "from": {"node": "get", "port": "value"}, "to": {"node": "add", "port": "amount"}}
    ]}}
   ```
   Later edits are [`graphEdit`](../reference/ops-detail.md#op-graphEdit)
   `{"owner": {"kind": "behavior", "id": "jumpcount"}, "ops": [...]}`.
2. Check it: `POST /api/v1/projects/<id>/content/behaviors/source` with
   `{"check": true, "graph": true, "behaviorId": "jumpcount"}` answers
   `compiled`, the `sourceDigest` and the declaration (or the problems with
   their nodes).
3. Acknowledge that digest ([`acknowledgeBehaviorTrust`](../reference/ops-detail.md#op-acknowledgeBehaviorTrust)),
   then publish: the same route with `{"graph": true, "behaviorId", "displayName", "expectedRevision", "requestId"}`.
4. Attach it ([`setBehaviorProperties`](../reference/ops-detail.md#op-setBehaviorProperties)):
   `{"entityId": "<player>", "behaviorId": "jumpcount", "values": {"per_jump": 2}}`.
5. Play; two jumps give `counters.jumps` = 4 in the observation.

## Which to use

Build graphs in the editor: wiring by hand, with the catalogue's search and
the problem badges, is what the editor is for, and the debugger only works
there. Send graphs over the API when a tool generates them. Choose a visual
script for event-driven logic that fits on a screen; choose
[TypeScript](scripts.md) for anything with real data structures or more
than a few dozen nodes. A visual script can call shared functions; a
TypeScript script can import a script library.

## Pitfalls

- **Editing does not publish.** Play and exports run the published script
  until you publish again.
- **Event phases.** Move object and Pose object run in the transform phase
  only; an intent event that reaches them is a compile problem.
- **Limits per graph:** 256 nodes and 32 functions per script, 10,000 loop
  iterations per step (more stops Play with a script error naming the loop
  node).
- **A data input takes one wire.** Over the API a second `connect` to the same
  input is refused; disconnect the old wire first (the editor replaces it).
- **Breakpoints are the editor's.** They are not project data, and exports
  never contain debug builds.

Related: [write a script](scripts.md), [the graph editor](../features/editor.md#graph-editing).
