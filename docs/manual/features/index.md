# Features

This part holds the full description of each feature area, one page per
area: everything a feature does, its settings and its edge cases. The
guides show how to do a task; these pages say everything there is to know.
Pages still marked *planned* are not moved yet; their text is in
[Deployment](../../deployment.md).

The pages, and the Deployment sections each took (or will take):

| Page | Deployment sections | Status |
|---|---|---|
| `editor.md` | Editor window, Script editor, The Inspector, Hierarchy: folders and flags, Tags, Icons and gizmos, Scene handles, Graph editing, What you can do now (editor layout) | *planned* |
| `projects.md` | Projects, Projects in a game's own folder, What you can do now (asset scale and streaming; engine and game kept apart) | *planned* |
| `assets.md` | The asset database, The project window, Supported glTF extensions, KTX2 textures, Texture streaming, Textures inside models, Generated levels of detail, Packed textures and texture arrays, Per-layer texture slots, Job exports from asset tools, FBX, Levels of detail, Deleting assets and prefabs | *planned* |
| `scenes-and-cameras.md` | The view, cameras and kept objects, Several player controllers (local co-op), Scenes, Cameras (virtual cameras) | *planned* |
| [instance-sets.md](instance-sets.md) | Instance sets | done |
| [lighting.md](lighting.md) | Baked lighting, Probe grids, Light layers, Local lights per pixel or per vertex | done |
| [environment.md](environment.md) | Grading and fog volumes, Height fog, Sky rotation, Environment presets | done |
| [rendering.md](rendering.md) | Renderer backends | done |
| `animation.md` | Animation (Animator), Sockets | *planned* |
| `material-graphs.md` | Material graphs, Trim sheets | *planned* |
| `visual-scripts.md` | Visual scripts, Debugging visual scripts in Play | *planned* |
| `effects.md` | Visual effects (particle graphs) | *planned* |
| `gameplay.md` | Gameplay blocks, Generic primitives, Scene transitions, impulses, facing, camera tracking, looks and event sounds, The game shell | *planned* |
| `scripting.md` | Timers and trigger events, Spawning prefabs, Loading assets by name, Script libraries and JSON data, The Console, `ctx.entity`, Callbacks, Random numbers, Script properties, The ground at a point | *planned* |
| `input.md` | Input actions, Pointer input and 3D queries, Input rebinding and glyphs | *planned* |
| `physics.md` | The player's collision capsule, Simulation thread (worker), 3D physics, The 3D character | *planned* |
| `audio.md` | Music, fonts and audio | *planned* |
| `saves.md` | Saves, Project save documents | *planned* |
| `debugging.md` | Test and debug entry points | *planned* |
| [tuning.md](tuning.md) | Tuning values, Engine limits, Engine defaults | done |
| `timelines.md` | Timelines (sequencer) | *planned* |
| [blocks.md](blocks.md) | Block layers, Block layer editing, Blocks on terrain | done |
| [terrain.md](terrain.md) | Terrain, Terrain edit layers, stamps and erosion, Rule scatter and ground cover, Splines | done |
| [architecture.md](architecture.md) | Generated architecture, Architecture styles and presets, Rooms and paths, Rooms drive culling and lighting, Buildings, Floor plans and furnishing | done |
| [streaming.md](streaming.md) | World streaming | done |
| [performance.md](performance.md) | Performance | done |
| `ui.md` | Project UI (UI documents), The UI document editor | *planned* |
| `game-modes.md` | Game modes | *planned* |
| `dialogue.md` | Dialogue | *planned* |
| `migration.md` | Migration notes | *planned* |

Deployment keeps running the server: requirements, starting, the service,
the reverse proxy, the token, backup and restore, the MCP connection,
upgrading and verification.
