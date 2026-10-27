# Engine reference

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

What the engine offers, generated from its source: the objects, components and content documents a project holds, the command ops that edit them, the script API, the node graph catalogues and the limits. For a lookup by topic (`component.light`, `op.editBlocks`, `ctx.grid`, `node.material.pbr`, `limit.MAX_TAGS`), `index.json` maps each topic to its page and section.

| Page | Sections |
|---|---|
| [Objects and components](objects.md) | Object fields, Components, Scene-view handle kinds |
| [Components: Object](components-object.md) | transform — Transform, socketAttach — Socket |
| [Components: Rendering (part 1)](components-rendering-1.md) | 15 sections |
| [Components: Rendering (part 2)](components-rendering-2.md) | spline — Spline, architecture — Architecture |
| [Components: Physics](components-physics.md) | collider — Collider, controller — Player controller |
| [Components: Camera](components-camera.md) | virtualCamera — Virtual camera, cameraPath — Camera path, cameraRegion — Camera region |
| [Components: Lighting](components-lighting.md) | light — Light |
| [Components: Gameplay](components-gameplay.md) | playerSpawn — Player spawn, mover — Mover, trigger — Trigger, switch — Switch, health — Health, collectible — Collectible, patrol — Patrol, hitbox — Hitbox, climbVolume — Climb volume, gravity — Gravity, blockFootprint — Block footprint |
| [Components: Audio](components-audio.md) | audioSource — Audio source |
| [Components: Animation](components-animation.md) | animator — Animator, faceMovement — Face movement, modelAnimation — Model animation (old) |
| [Components: Scripting](components-scripting.md) | behavior — Script, behaviorGroup — Behavior group |
| [Components: Organisation](components-organisation.md) | prefab — Prefab link, folder — Folder |
| [Content documents](content.md) | Content blocks |
| [Content documents (environment to input)](content-blocks-environment.md) | environment — Environment, input — Input |
| [Content documents (materials to animators)](content-blocks-materials.md) | materials — Materials, animators — Animator controllers |
| [Content documents (effects to saveSchema)](content-blocks-effects.md) | 22 sections |
| [Content documents (settings to lighting)](content-blocks-settings.md) | settings — Gameplay settings, scenes — Scenes, startScenes — Start scenes, assets — Assets, prefabs — Prefabs, behaviors — Behaviors, behaviorTrust — Script trust, lighting — Baked lighting |
| [Scene environment](scene-environment.md) | sky — Sky, fog — Fog, heightFog — Height fog, post — Post-processing, wind — Wind, wetness — Wetness |
| [UI documents](ui.md) | UI document, Widget, Style, Tween |
| [Command ops](ops.md) | The request, Every op |
| [Command op arguments](ops-detail.md) | 87 sections |
| [Types (AcknowledgeBehaviorTrustArgs to CreatePrefabArgs)](types-a-c.md) | 74 sections |
| [Types (CreatePrefabVariantArgs to PackedChannel)](types-c-p.md) | 96 sections |
| [Types (PackedFrom to TimelineValue)](types-p-t.md) | 98 sections |
| [Types (TrimCell to WindOctave)](types-t-w.md) | 33 sections |
| [Script API](script-api.md) | What a script exports, The context (`ctx`), Context members in full, `BehaviorPrepareConfig`, `BehaviorInstanceInfo` |
| [Script API types (from `BehaviorContext`)](script-types-behavior-context.md) | 21 sections |
| [Script API types (from `BehaviorMessages`)](script-types-behavior-messages.md) | 21 sections |
| [Script API types (from `BehaviorMaterials`)](script-types-behavior-materials.md) | 48 sections |
| [Script API types (from `InputRebindTarget`)](script-types-input-rebind-target.md) | 77 sections |
| [Script API types (from `BlockCell`)](script-types-block-cell.md) | 18 sections |
| [Node graphs](graphs.md) | Graph kinds |
| [Graph: Animator layer](graph-animator.md) | Animator layer, States |
| [Graph: Animator override layer](graph-animator-layer.md) | Animator override layer, States |
| [Graph: Blend tree](graph-animator-blend.md) | Blend tree, Blend |
| [Graph: Visual script (part 1, from Visual script)](graph-behavior-1.md) | Visual script, Events, Flow, Variables, Functions, Constants, Maths, Logic, Text, Vectors, Lists |
| [Graph: Visual script (part 2, from Index of (`list.indexOf`))](graph-behavior-2.md) | Maps, Random, Debug, Script, Action, Intents, Settings, Physics |
| [Graph: Visual script (part 3, from Character state (`api.physics.characterState`))](graph-behavior-3.md) | Tags, World, Scenes, Input, Animator, Timers, Signals, Messages, Game, Health |
| [Graph: Visual script (part 4, from Health events (`api.health.events`))](graph-behavior-4.md) | Patrol, Hitbox, Collectible, Character, Look, Audio, Effects, Decals, Save, Grid |
| [Graph: Visual script (part 5, from World to cell (`api.grid.worldToCell`))](graph-behavior-5.md) | Scatter, Splines, Surface, Camera, Sockets, Materials |
| [Graph: Visual script (part 6, from Material data cell (`api.materials.getData`))](graph-behavior-6.md) | Saves, Assets, UI, Stats, Display, Dialogue, Modes, Lifecycle, Timeline, Environment |
| [Graph: Visual script (part 7, from Environment weight (`api.environment.weight`))](graph-behavior-7.md) | Entity, Shell |
| [Graph: Script function (part 1, from Script function)](graph-behavior-function-1.md) | 32 sections |
| [Graph: Script function (part 2, from Input)](graph-behavior-function-2.md) | 23 sections |
| [Graph: Script function (part 3, from Saves)](graph-behavior-function-3.md) | Saves, Assets, UI, Stats, Display, Dialogue, Modes, Lifecycle, Timeline, Environment, Entity, Shell |
| [Graph: Shared script function (part 1, from Shared script function)](graph-behavior-library-1.md) | 21 sections |
| [Graph: Shared script function (part 2, from Input)](graph-behavior-library-2.md) | 23 sections |
| [Graph: Shared script function (part 3, from Saves)](graph-behavior-library-3.md) | Saves, Assets, UI, Stats, Display, Dialogue, Modes, Lifecycle, Timeline, Environment, Entity, Shell |
| [Graph: Material graph](graph-material.md) | Material graph, Inputs, Lighting, Maths, Vectors, Textures, Utility, Functions, Output |
| [Graph: Material function](graph-material-function.md) | Material function, Interface, Inputs, Lighting, Maths, Vectors, Textures, Utility, Functions |
| [Graph: Particle system](graph-effect.md) | Particle system, Contexts, Spawn, Position, Initialize, Forces, Collision, Over life, Kill, Output, Values, Maths |
| [Graph: Dialogue](graph-dialogue.md) | Dialogue, Flow, Lines, Logic, Events |
| [Graph: Architecture style](graph-architecture-style.md) | Architecture style, Inputs, Math, Paths, Profiles, Elements, Output |
| [Graph: Architecture preset](graph-architecture-preset.md) | Architecture preset, Preset, Values |
| [Graph: Room program](graph-room-program.md) | Room program, Program, Rooms |
| [Graph: Furnishing set](graph-furnishing-set.md) | Furnishing set, Furnishing, Props |
| [Limits and defaults](limits.md) | By package |
| [Limits and defaults: asset-pipeline](limits-asset-pipeline.md) | `inspect-font.ts`, `inspect-image.ts`, `limits.ts`, `simplify.ts` |
| [Limits and defaults: behavior-build](limits-behavior-build.md) | `limits.ts` |
| [Limits and defaults: commands](limits-commands.md) | `terrain-erosion-ops.ts` |
| [Limits and defaults: game-host](limits-game-host.md) | `audio.ts`, `rebind.ts`, `sim-protocol.ts`, `storage.ts` |
| [Limits and defaults: project-model (part 1, from `animator.ts`)](limits-project-model-1.md) | 37 sections |
| [Limits and defaults: project-model (part 2, from `material-schema.ts`)](limits-project-model-2.md) | 40 sections |
| [Limits and defaults: protocol](limits-protocol.md) | `bake.ts`, `bridge.ts`, `content.ts`, `delivery.ts`, `diagnostics-bound.ts`, `errors.ts`, `http.ts`, `job-export.ts`, `m3.ts`, `play-problems.ts`, `wire-change.ts`, `ws-events.ts` |
| [Limits and defaults: runtime](limits-runtime.md) | 26 sections |
| [MCP tools (part 1, from tl_command)](mcp-tools-1.md) | `tl_command` |
| [MCP tools (part 2, from tl_command: Models, bulk creation, deleting, asset options, imports, labels, addresses, files)](mcp-tools-2.md) | 17 sections |
| [MCP tools (part 3, from tl_command: Block layers: block types, the layer component, editBlocks, stamps)](mcp-tools-3.md) | `tl_content_job`, `tl_content_query`, `tl_content_upload`, `tl_diagnostics`, `tl_docs`, `tl_game_control`, `tl_game_observe` |
| [MCP tools (part 4, from tl_input_exercise)](mcp-tools-4.md) | `tl_input_exercise`, `tl_inspect`, `tl_instance_buffer`, `tl_play_start`, `tl_play_stop`, `tl_playtest`, `tl_screenshot`, `tl_script_publish`, `tl_sessions` |

The topic kinds: `component`, `components`, `content`, `ctx`, `entity`, `graph`, `graphs`, `handles`, `limit`, `limits`, `node`, `op`, `ops`, `scene-environment`, `script-type`, `script`, `tool`, `type`, `ui`.
