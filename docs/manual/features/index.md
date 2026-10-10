# Features

This part holds the full description of each feature area, one page per
area: everything a feature does, its settings and its edge cases. The
guides show how to do a task; these pages say everything there is to know.
Running the server itself is in [Deployment](../../deployment.md).

The pages, and the Deployment sections each took:

| Page | Deployment sections | Status |
|---|---|---|
| [editor.md](editor.md) | Editor window, Script editor, The Inspector, Hierarchy: folders and flags, Tags, Icons and gizmos, Scene handles, Graph editing, What you can do now (editor layout) | done |
| [projects.md](projects.md) | Projects, Projects in a game's own folder, What you can do now (asset scale and streaming; engine and game kept apart) | done |
| [assets.md](assets.md) | The asset database, The project window, Supported glTF extensions, KTX2 textures, Texture streaming, Textures inside models, Generated levels of detail, Packed textures and texture arrays, Per-layer texture slots, Job exports from asset tools, FBX, Levels of detail, Deleting assets and prefabs | done |
| [scenes-and-cameras.md](scenes-and-cameras.md) | The view, cameras and kept objects, Several player controllers (local co-op), Scenes, Cameras (virtual cameras), MCP: scene preparation and transitions | done |
| [instance-sets.md](instance-sets.md) | Instance sets | done |
| [lighting.md](lighting.md) | Baked lighting, Probe grids, Light layers, Local lights per pixel or per vertex | done |
| [environment.md](environment.md) | Grading and fog volumes, Height fog, Sky rotation, Environment presets | done |
| [rendering.md](rendering.md) | Renderer backends | done |
| [animation.md](animation.md) | Animation (Animator), Sockets | done |
| [material-graphs.md](material-graphs.md) | Material graphs, Trim sheets | done |
| [visual-scripts.md](visual-scripts.md) | Visual scripts, Debugging visual scripts in Play | done |
| [effects.md](effects.md) | Visual effects (particle graphs) | done |
| [gameplay.md](gameplay.md) | Gameplay blocks, Generic primitives, Scene transitions, impulses, facing, camera tracking, looks and event sounds, The game shell | done |
| [scripting.md](scripting.md) | Timers and trigger events, Spawning prefabs, Loading assets by name, Script libraries and JSON data, The Console, `ctx.entity`, Callbacks, Random numbers, Script properties, The ground at a point | done |
| [input.md](input.md) | Input actions, Pointer input and 3D queries, Input rebinding and glyphs | done |
| [physics.md](physics.md) | The player's collision capsule, Simulation thread (worker), 3D physics, The 3D character | done |
| [audio.md](audio.md) | Music, fonts and audio | done |
| [saves.md](saves.md) | Saves, Project save documents | done |
| [play-tools.md](play-tools.md) | MCP (coding harness): what the play tools do — stepping a play, the engine's version, headless play-tests, screenshots, replays, ended plays, start timings, how a Play loads, descriptors | done |
| [debugging.md](debugging.md) | Test and debug entry points | done |
| [tuning.md](tuning.md) | Tuning values, Engine limits, Engine defaults | done |
| [timelines.md](timelines.md) | Timelines (sequencer) | done |
| [blocks.md](blocks.md) | Block layers, Block layer editing, Blocks on terrain | done |
| [terrain.md](terrain.md) | Terrain, Terrain edit layers, stamps and erosion, Rule scatter and ground cover, Splines | done |
| [architecture.md](architecture.md) | Generated architecture, Architecture styles and presets, Rooms and paths, Rooms drive culling and lighting, Buildings, Floor plans and furnishing | done |
| [decals.md](decals.md) | — (new: the decal component, decal layers, decal materials, trim sheet decal cells) | growing |
| [streaming.md](streaming.md) | World streaming | done |
| [performance.md](performance.md) | Performance | done |
| [ui.md](ui.md) | Project UI (UI documents), The UI document editor | done |
| [game-modes.md](game-modes.md) | Game modes | done |
| [dialogue.md](dialogue.md) | Dialogue | done |
| [migration.md](migration.md) | Migration notes | done |

Deployment keeps running the server: requirements, starting, the service,
the reverse proxy, the token, the MCP connection and the headless editor,
backup and restore (folder projects included), upgrading and verification.
