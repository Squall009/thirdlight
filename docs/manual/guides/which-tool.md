# Which tool for which job

Thirdlight offers several ways to put things in a level and to make them
behave. This page tells you which to pick. Each choice links the guide that
walks through it.

## Level geometry

| You want | Use | Why |
|---|---|---|
| Floors, walls, buildings, a dungeon, a tactics map | [Block layer](block-layers.md) in the [block editor](block-editor.md) (start from the 3D starter) | A grid you paint: merged meshes and colliders per chunk, cell data scripts read (`ctx.grid`), walk queries, regions, cut-aways |
| Open ground to the horizon: hills, valleys, roads | [Terrain](terrain.md) | A heightfield with levels of detail; sculpted, painted by rules, streamed |
| A road, a path, a river, a fence along a curve | A spline ([terrain guide](terrain.md#a-road-or-a-river-splines)) | Shapes and paints the terrain, makes its own mesh and pieces |
| Rooms and buildings with mouldings, doors and roofs | [Generated architecture](generated-architecture.md) on a block layer | Parameters, not meshes: restyle a whole level by swapping presets |
| Interiors seen from a follow camera: walls in front out of the way | See-through and a roof cut-away ([interiors guide](interiors.md)) | See-through dithers what is between the camera and the player, never floors; the cut-away hides the roof and the storeys above |
| A courtyard or village set into a landscape | A block layer on terrain ([terrain guide](terrain.md#a-block-area-on-terrain)) | The ground meets the blocks without a seam |
| The ground of a side-view (2D) level: slopes, stairs, ledges, pits | A [block layer](block-layers.md) in a 2D project | It collides where it crosses the play plane; one-way block types make ledges |

## Things placed in a level

| You want | Use | Why |
|---|---|---|
| Something the player uses, a script drives, or that moves | An object (box, model, prefab copy) | Each has an id, components, a collider and scripts |
| The same object many times, each with its own behaviour | A [prefab](prefabs.md) | One definition; placed copies follow its edits except what they override, and every spawn uses its latest contents |
| A door, lamp or trigger that belongs to the level's grid | A **live** block type ([block layers](block-layers.md)) | Spawned per cell; its id comes from the cell |
| Many copies placed by hand: rocks, crates, grass patches | An [instance set](instance-sets.md) | Up to 65,536 copies of one model in a few draws; no ids or colliders |
| Copies laid by rules over the ground: forests, rocks, grass | Rule scatter ([terrain guide](terrain.md#rule-scatter-and-ground-cover)) | Baked from rules, re-baked when the ground changes; ground cover made near the camera; per-copy colliders and script addresses (`ctx.scatter`) |

## Behaviour

| You want | Use | Why |
|---|---|---|
| Game rules, AI, anything with logic you want to read and diff | A [script](scripts.md) (TypeScript) | A full language and shared libraries |
| Small wiring: open a door on a signal, play a sound on a trigger | A [visual script](visual-scripts.md) | Nodes in the editor, compiled to the same kind of script |
| A door that opens on a signal, a platform that moves, a pickup | The engine's gameplay components (mover, switch, trigger, collectible) | No script at all |
| A cutscene: cameras, a character walking to a mark, fades, sounds | A [timeline](timelines.md) (its Character track walks a player character) | Timed on a ruler and previewed in the editor; scripts play it, and `ctx.character` walks a character without one |
| The next level, a title, a restart | A director script with [`ctx.scenes`](game-flow.md) | Your game owns its flow; the engine only loads, unloads and picks the active look |

Scripts and visual scripts run the same way (see
[the step model](../concepts/scripts-and-the-step-model.md)). Pick by who
edits them: a programmer reads a script in a diff; a designer reads a
graph.

## Editor or API

Every tool above is the same set of commands in the editor and through the
API (the HTTP commands, or MCP for AI tools). Use the editor for what you
judge by eye — painting, sculpting, lighting, looks. Use the API for what
should be repeatable — generated layouts, imported data, setup applied to
many scenes. See [The editor and the API](../concepts/editor-and-api.md).
