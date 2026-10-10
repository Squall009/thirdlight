# Engine reference

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

What the engine offers, generated from its source: the objects, components and content documents a project holds, the command ops that edit them, the script API, the node graph catalogues and the limits. For a lookup by topic (`component.light`, `op.editBlocks`, `ctx.grid`, `node.material.pbr`, `limit.MAX_TAGS`), `index.json` maps each topic to its page and section.

| Page | Sections |
|---|---|
| [Objects and components](objects.md) | Object fields, Components, Scene-view handle kinds |
| [Components: Object](components-object.md) | transform — Transform, socketAttach — Socket |
| [Components: Rendering (part 1)](components-rendering-1.md) | 13 sections |
| [Components: Rendering (part 2)](components-rendering-2.md) | architecture — Architecture |
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
| [Content documents (materials to effects)](content-blocks-materials.md) | materials — Materials, animators — Animator controllers, effects — Effects |
| [Content documents (scriptLibraries to prefabs)](content-blocks-script-libraries.md) | 25 sections |
| [Content documents (behaviors to lighting)](content-blocks-behaviors.md) | behaviors — Behaviors, behaviorTrust — Script trust, lighting — Baked lighting |
| [Scene environment](scene-environment.md) | sky — Sky, fog — Fog, heightFog — Height fog, post — Post-processing, wind — Wind, wetness — Wetness |
| [UI documents](ui.md) | UI document, Widget, Style, Tween |
| [Command ops](ops.md) | The request, Every op |
| [Command op arguments](ops-detail.md) | 78 sections |
| [Types (AcknowledgeBehaviorTrustArgs to DialogueDocument)](types-a-d.md) | 76 sections |
| [Types (DialogueSettings to PublishAssetAnimation)](types-d-p.md) | 99 sections |
| [Types (PublishAssetArgs to UpdateEntityArgs)](types-p-u.md) | 88 sections |
| [Types (V3OwnedComponent to WindConfig)](types-v-w.md) | 3 sections |
| [Script API](script-api.md) | What a script exports, The context (`ctx`), Context members in full, `BehaviorPrepareConfig`, `BehaviorInstanceInfo` |
| [Script API types (from `BehaviorContext`)](script-types-behavior-context.md) | 24 sections |
| [Script API types (from `BehaviorPatrol`)](script-types-behavior-patrol.md) | 21 sections |
| [Script API types (from `BehaviorStats`)](script-types-behavior-stats.md) | 60 sections |
| [Script API types (from `GridVec3`)](script-types-grid-vec3.md) | 72 sections |
| [Node graphs](graphs.md) | Graph kinds |
| [Graph: Animator layer](graph-animator.md) | Animator layer, States |
| [Graph: Animator override layer](graph-animator-layer.md) | Animator override layer, States |
| [Graph: Blend tree](graph-animator-blend.md) | Blend tree, Blend |
| [Graph: Visual script (part 1, from Visual script)](graph-behavior-1.md) | Visual script, Events, Flow, Variables, Functions, Constants, Maths, Logic, Text, Vectors, Lists |
| [Graph: Visual script (part 2, from Index of (`list.indexOf`))](graph-behavior-2.md) | Maps, Random, Debug, Script, Action, Intents, Settings, Physics, Tags, World |
| [Graph: Visual script (part 3, from World transform of (`api.world.worldTransform`))](graph-behavior-3.md) | 84 sections |
| [Graph: Visual script (part 4, from Audio)](graph-behavior-4.md) | Audio, Effects, Save, Grid |
| [Graph: Visual script (part 5, from Edge object (`api.grid.edgeEntity`))](graph-behavior-5.md) | Scatter, Splines, Surface, Camera, Sockets, Materials, Saves, Assets, UI, Stats |
| [Graph: Visual script (part 6, from Stats cpu ms (`api.stats.cpuMs`))](graph-behavior-6.md) | Display, Dialogue, Modes, Lifecycle, Timeline, Environment, Entity, Shell |
| [Graph: Script function (part 1, from Script function)](graph-behavior-function-1.md) | 33 sections |
| [Graph: Script function (part 2, from Animator)](graph-behavior-function-2.md) | 24 sections |
| [Graph: Script function (part 3, from Stats)](graph-behavior-function-3.md) | Stats, Display, Dialogue, Modes, Lifecycle, Timeline, Environment, Entity, Shell |
| [Graph: Shared script function (part 1, from Shared script function)](graph-behavior-library-1.md) | 23 sections |
| [Graph: Shared script function (part 2, from Timers)](graph-behavior-library-2.md) | 25 sections |
| [Graph: Shared script function (part 3, from Dialogue)](graph-behavior-library-3.md) | Dialogue, Modes, Lifecycle, Timeline, Environment, Entity, Shell |
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
| [Limits and defaults: commands](limits-commands.md) | `errors.ts`, `ops.ts`, `terrain-erosion-ops.ts` |
| [Limits and defaults: game-host](limits-game-host.md) | `audio.ts`, `rebind.ts`, `sim-protocol.ts`, `storage.ts` |
| [Limits and defaults: project-model (part 1, from `animator.ts`)](limits-project-model-1.md) | 35 sections |
| [Limits and defaults: project-model (part 2, from `model-lod.ts`)](limits-project-model-2.md) | 30 sections |
| [Limits and defaults: protocol](limits-protocol.md) | `bake.ts`, `bridge.ts`, `content.ts`, `delivery.ts`, `diagnostics-bound.ts`, `errors.ts`, `http.ts`, `job-export.ts`, `m3.ts`, `play-problems.ts`, `ws-events.ts` |
| [Limits and defaults: runtime](limits-runtime.md) | 25 sections |
| [MCP tools (part 1, from tl_command)](mcp-tools-1.md) | `tl_command` |
| [MCP tools (part 2, from tl_command: Cameras and sockets)](mcp-tools-2.md) | `tl_content_job`, `tl_content_query` |
| [MCP tools (part 3, from tl_content_upload)](mcp-tools-3.md) | 14 sections |

The topic kinds: `component`, `components`, `content`, `ctx`, `entity`, `graph`, `graphs`, `handles`, `limit`, `limits`, `node`, `op`, `ops`, `scene-environment`, `script-type`, `script`, `tool`, `type`, `ui`.
