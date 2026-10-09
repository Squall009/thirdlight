# Objects and components

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

An object (entity) is a node of a scene: its own fields below, and components that give it a look, physics, gameplay and scripts. Components are set with the `setComponent` op (or the Inspector).

<a id="entity"></a>
## Object fields

An object in a scene.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `id` | string, id, 1–64 chars |  |  | **Id.** The stable object id. (required; written by a tool; scripts read; format id) |
| `name` | string, name, 1–128 chars |  |  | **Name.** The name shown in the Hierarchy. (scripts read; format name) |
| `parentId` | object id | `null` |  | **Parent.** The parent object (none: a scene root). (may be null; scripts read) |
| `active` | bool | `true` |  | **Active.** Inactive objects are not in the game (an object a script switches off stays loaded but is not drawn, collides with nothing, fires no trigger and does not tick). (stored only when not the default; scripts read and write) |
| `visible` | bool | `true` |  | **Visible.** Drawn (with its children, their lights and effects). Off: the object starts hidden until a script or a timeline shows it; it still collides, triggers and ticks while hidden. (stored only when not the default; scripts read and write) |
| `locked` | bool | `false` |  | **Locked.** Cannot be selected in the Scene view. (stored only when not the default) |
| `static` | bool | `false` |  | **Static.** Never moves (baked lighting, cheaper rendering). (stored only when not the default; scripts read) |
| `keepLoaded` | bool | `false` |  | **Keep loaded.** Survives scene changes (with its children and scripts): loading, unloading or reloading its scene, or loading a save, never destroys it. On a root object (or one in folders). (stored only when not the default; scripts read and write) |
| `tags` | int | `0` | 0 – 4294967295, step 1 | **Tags.** The tag bits (a 32-bit mask of the project's tags). (stored only when not the default; scripts read) |
| `components` | components (40 kinds) |  |  | **Components.** What the object is and does. (required; allowed: `transform`, `model`, `box`, `materials`, `materialParams`, `effect`, `surface`, `instances`, `fogVolume`, `probeVolume`, `collider`, `controller`, `virtualCamera`, `cameraPath`, `cameraRegion`, `socketAttach`, `light`, `playerSpawn`, `mover`, `trigger`, `switch`, `health`, `collectible`, `patrol`, `hitbox`, `climbVolume`, `gravity`, `audioSource`, `animator`, `faceMovement`, `modelAnimation`, `behavior`, `prefab`, `folder`, `blockLayer`, `blockFootprint`, `behaviorGroup`, `terrain`, `spline`, `architecture`) |

<a id="component-index"></a>
## Components

Every component, in "+ Add component" order within its category.

| Component | Name | Category | What it does |
|---|---|---|---|
| [`transform`](components-object.md#component-transform) | Transform | Object | Where the object is, how it is turned and how big it is (relative to its parent). |
| [`model`](components-rendering.md#component-model) | Model | Rendering | Shows an imported 3D model (a whole file or one named piece of it). |
| [`box`](components-rendering.md#component-box) | Box | Rendering | A simple coloured box (blocking out a level, placeholders). |
| [`materials`](components-rendering.md#component-materials) | Materials | Rendering | Which project material each of the object's materials uses ("*": all of them). |
| [`materialParams`](components-rendering.md#component-materialParams) | Material parameters | Rendering | This object's values for the public parameters of its graph materials (the materials keep their own values elsewhere). |
| [`effect`](components-rendering.md#component-effect) | Effect | Rendering | Plays a visual effect (particles) from this object. Visual only: it never changes the game simulation. |
| [`surface`](components-rendering.md#component-surface) | Surface | Rendering | Simple look overrides for a box or model: colour, roughness, metalness and glow. |
| [`instances`](components-rendering.md#component-instances) | Instance set | Rendering | One model placed many times (grass, rocks, trees), stored as a binary transform buffer. |
| [`fogVolume`](components-rendering.md#component-fogVolume) | Fog volume | Rendering | A box of fog (mist in a valley, smoke in a room). |
| [`probeVolume`](components-rendering.md#component-probeVolume) | Probe volume | Rendering | A box the probe bake fills with light probes (Lighting window → Bake probes). Without any, the bake covers the static objects. |
| [`collider`](components-physics.md#component-collider) | Collider | Physics | A solid shape the player stands on and bumps into (a box or a convex polygon in the X/Y plane; in a 3D project a box with a depth, a sphere, a capsule, a convex hull or a triangle mesh), placed anywhere in the object's frame; several shapes as a compound, or the convex parts of its model's _COL node. |
| [`controller`](components-physics.md#component-controller) | Player controller | Physics | Makes this object the player: it runs, jumps and collides with a capsule. |
| [`virtualCamera`](components-camera.md#component-virtualCamera) | Virtual camera | Camera | A camera shot the game cuts or blends to: follow/orbit a target, orbit a point in snapped turns, top-down, fixed/look-at, along a rail, or track a target with a dead zone and bounds. The live one is the enabled camera with the highest priority (on a tie the one activated last); it is what the game shows (without one the view holds a default pose and Play warns). |
| [`cameraPath`](components-camera.md#component-cameraPath) | Camera path | Camera | A path rail cameras ride (points as offsets from where this object is placed). |
| [`cameraRegion`](components-camera.md#component-cameraRegion) | Camera region | Camera | While a track camera's target is inside this box, the camera uses the region's dead zone, bounds and distance (each absent: the camera's own); entering or leaving blends between them. A room, a corridor, an arena, a vista: any place that frames differently. |
| [`socketAttach`](components-object.md#component-socketAttach) | Socket | Object | Rides on a named node (a bone or any node) of another object's model, with an offset: equipment in a hand, a rider on a mount, a pilot in a cockpit. The simulation places it every step, following the target's animation; scripts attach and detach at run time (ctx.sockets). |
| [`light`](components-lighting.md#component-light) | Light | Lighting | A light: directional (the sun), ambient, point, spot or hemisphere (sky and ground). |
| [`playerSpawn`](components-gameplay.md#component-playerSpawn) | Player spawn | Gameplay | Where the player starts (a level names its spawn). |
| [`mover`](components-gameplay.md#component-mover) | Mover | Gameplay | Moves the object along waypoints (a moving platform, a door); with a collider it carries the player. |
| [`trigger`](components-gameplay.md#component-trigger) | Trigger | Gameplay | Sends a signal when the player enters an area (a box or a circle; in a 3D project a box with a depth, a sphere or a capsule). |
| [`switch`](components-gameplay.md#component-switch) | Switch | Gameplay | A lever or button (interact) or a pressure plate (stand) that sends a signal. |
| [`health`](components-gameplay.md#component-health) | Health | Gameplay | The object's health (any object): scripts damage and heal it and hear when it is damaged or reaches 0; a hitbox with damage takes some on contact. |
| [`collectible`](components-gameplay.md#component-collectible) | Collectible | Gameplay | The character touching it adds an amount to a named counter; it hides, sends a signal and may come back after a while. |
| [`patrol`](components-gameplay.md#component-patrol) | Patrol | Gameplay | Walks by itself: along waypoints, or straight ahead turning around at walls and ledges. |
| [`hitbox`](components-gameplay.md#component-hitbox) | Hitbox | Gameplay | An area whose contacts with other hitboxes and the character are events for scripts (the other object and the contact normal); may take health on contact. |
| [`climbVolume`](components-gameplay.md#component-climbVolume) | Climb volume | Gameplay | A box the character climbs in (a ladder, a vine, a net, a climbing wall): up/down moves it along the box's up axis, sideways across it, at its climb speed and without gravity; jump or moving out leaves. |
| [`gravity`](components-gameplay.md#component-gravity) | Gravity | Gameplay | The object (not a character: a patroller, an item) falls under the project's gravity until its body rests on a collider below it, and falls again when the floor goes. |
| [`audioSource`](components-audio.md#component-audioSource) | Audio source | Audio | A looping sound here, louder as the player comes near (along X), or panned around the camera (the project's Audio sources setting; 3D projects). |
| [`animator`](components-animation.md#component-animator) | Animator | Animation | Plays the model's animations with an animator controller (a state machine). |
| [`faceMovement`](components-animation.md#component-faceMovement) | Face movement | Animation | Turns this model to face where its parent (or, at the top, itself) is going: to one of two yaws by the side it moves to, or toward its motion in any direction. |
| [`modelAnimation`](components-animation.md#component-modelAnimation) | Model animation (old) | Animation | The old idle/run/airborne clip roles. Projects are moved to an animator when opened; this stays only where the clips could not be measured. |
| [`behavior`](components-scripting.md#component-behavior) | Script | Scripting | Runs a published behavior (script) on this object with per-object property values. |
| [`prefab`](components-organisation.md#component-prefab) | Prefab link | Organisation | Which prefab (and which of its entities) this object was placed from. |
| [`folder`](components-organisation.md#component-folder) | Folder | Organisation | Organises objects in the Hierarchy; carries nothing else. |
| [`blockLayer`](components-rendering.md#component-blockLayer) | Block layer | Rendering | A grid of blocks for building levels (terrain, buildings, a tactics map); its cells are painted and edited with block commands. |
| [`blockFootprint`](components-gameplay.md#component-blockFootprint) | Block footprint | Gameplay | The cell metadata this object writes into the block-layer cells beneath it when it is placed or moved (a house marks its cells blocked). |
| [`behaviorGroup`](components-scripting.md#component-behaviorGroup) | Behavior group | Scripting | The group this object's behavior belongs to. A game mode lists the groups that tick while it is active; the others pause (their scripts do not run). |
| [`terrain`](components-rendering.md#component-terrain) | Terrain | Rendering | A heightfield of square tiles for landscape reaching the horizon, sculpted, painted and cut with the terrain commands (editTerrain). |
| [`spline`](components-rendering.md#component-spline) | Spline | Rendering | A curve through points, each with its own width and roll: roads, paths and rivers carved and painted into terrain, meshes and models along it, and a path scripts read (ctx.splines). |
| [`architecture`](components-rendering.md#component-architecture) | Architecture | Rendering | Walls, mouldings, floors, vaults, roofs and repeated pieces generated at load from parameters: profiles swept along paths, things repeated along paths, and fills, on one trim sheet (Materials slot "architecture"). |

<a id="handle-kinds"></a>
## Scene-view handle kinds

The handles the Scene view draws and drags, and the field roles each binds (alternative sets).

| Kind | Roles |
|---|---|
| box2 | size or halfX + halfY or halfX + halfY + halfZ |
| box3 | size |
| radius | radius |
| capsule | radius + height + offset or radius + height |
| cone | direction + angle + range |
| direction | direction |
| path | points |
| polygon | vertices |
| point | point |
| height | height |
| bounds | min + max |
| spline | points |
