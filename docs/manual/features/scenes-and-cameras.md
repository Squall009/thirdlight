# Scenes and cameras

The view and its cameras, kept objects, several players sharing the view,
scenes and loading them while the game runs, and virtual cameras. The
idea: [Projects and scenes](../concepts/projects-and-scenes.md) and
[Game flow belongs to your game](../concepts/game-flow.md); step by step:
[the cameras guide](../guides/cameras.md), [the game-flow guide](../guides/game-flow.md)
and [local co-op](../guides/co-op.md).

## The view, cameras and kept objects

The engine owns the view. A camera is a shot: a `virtualCamera` (GameObject
→ Cameras → Camera for a plain one; follow, orbit, top-down, rail and track
rigs as before) in any scene, any number of them. The view shows the enabled
camera with the highest priority (on a tie the one activated last); its
lens is the camera's own `fovY`/`near`/`far`, else the project's camera
settings (Gameplay → Camera: `camera_fov_deg` 60, `camera_near_m` 0.1,
`camera_far_m` 100). With no camera live the view holds a default pose
(1.6 m up, 6 m back along +Z, looking down −Z): Play and the export start
anyway and write one Problems line ("no camera is live when the game
starts"); the game's log warns whenever the view falls back to it.
Every view read is keyed by a view (`readCameraView(…, view)`): there is one
view today, so a second one (a split screen) is a new key.

Checked when the game starts (Play and the export), not per edit — each a
Problems line: no camera live (warning), a player in a scene the game does
not start with (warning: loading it is refused while the game runs), one id
kept loaded in two scenes (refused), Keep loaded under an object that is not
kept (warning). Any number of player controllers may start together; they
share the view (see [Several player controllers](#several-player-controllers-local-co-op)).

### Several player controllers (local co-op)

A scene may hold several objects with a Character controller. They share the
one view and each is a player: its own physics body (players pass through
each other and are never in the way of a ray or an overlap query), its own
input and its own state.

- **Input.** Each controller names the actions it reads — `moveAction`,
  `jumpAction`, `runAction` (3D), `climbAction` — so the second player reads
  `move_p2` and `jump_p2` (any names) bound to its own keys. A gamepad
  binding may name one pad: `pad` is the pad's slot (0 for the first pad the
  browser lists, up to 3; Project Settings → Input, "pad 1"…"pad 4"), so each
  player plays on a pad of their own; without `pad` a binding reads the pad
  used last, as a one-player game does.
- **Scripts.** Every call about "the player" names the controller's object
  and defaults to the first controller (the first in the scene's order), so
  a one-player game never names it: the intents `control_move`,
  `control_jump`, `character_move`, `character_place`, `character_enable`
  and `respawn` take `entityId` right after `kind`;
  `ctx.character.impulse(v, entityId?)`, `ctx.lifecycle.respawn(spawnId?,
  entityId?)`, `ctx.physics.characterState(entityId?)`,
  `ctx.physics.characterResult(entityId?)`, `ctx.game.health(entityId?)`.
  Visual-script nodes drive the first controller (their player input picks
  another where they have one).
- **Triggers, switches, pickups.** Every player takes part: a trigger's
  `enter`/`exit` events name the player (`by`), its signal fires when the
  first player enters and its exit signal when the last one leaves; a
  switch or a collectible reacts to any player (a collect event's `by` names
  who).
- **Placement.** A scene transition's arrival, a listed scene's spawn (each
  kept player) and a run restart place every player; a respawn or a
  `character_place` places the one it names.
- **Saves.** The save's `world.character` is the first player's place;
  `world.characters` keeps the others by their object (an older save has
  none: they stay where they are).
- **Observation.** `tl_game_observe` (and the export's
  `window.__thirdlightObserve`) add `players` [{id, x, y, z}] when there are
  several; `player` stays the first one's.
- A player's physics body is made when the game starts, so a scene loaded
  later or a spawned copy cannot bring one (the `player_scene` warning):
  put every player in a start scene and keep it loaded.

**Upgrade (schemaVersion 7, on open).** A project's scene `camera` entity
becomes a fixed virtual camera at the lowest priority, where it was placed
(the view whenever no other camera is live, as before); its lens becomes the
project's camera settings where it was not the default. The camera and the
player (each start scene's controller) were never unloaded before, so the
object at the top of each one's hierarchy gets **Keep loaded**. A game with a
camera entity in a start scene, or a title scene holding the camera and the
player, plays as it did; clear Keep loaded to let them go with their scene.
A 3D character moves as it did: a 3D project without any virtual camera
moved along the world axes, so the upgrade sets each controller's **Move
relative to** to **World axes** (`moveFrame: "world"`); a project with virtual
cameras keeps **Camera**, as they turned the input before. Only where such a
project's old scene camera, turned about Y, is the one live shot does the
input now follow its heading; the upgrade notes name that camera.

Scripts: `ctx.spawn(prefab, {position, keepLoaded: true})` spawns a kept
copy; `ctx.entity(id).set('object', {keepLoaded})` keeps an object (and its
children) or lets it go (refused for an object under a kept parent, and for
a kept object whose scene is not loaded); `get('object').keepLoaded` reads
it. A save's world (an opt-in section, see [Saves](saves.md)) never destroys a kept
object; the engine saves nothing for them — a game fills them in from its
own save data.

## Scenes

A project has one or more scenes, one file each. Entity ids are
unique across the whole project. One command edits one scene.

- **Start scenes.** The game starts with the scenes in the start set,
  merged. The player (the controller) is made when the game starts, so it
  is in a start scene; cameras and spawns may be in any scene.
- **New objects** go into the scene the editor has active (or their
  parent's). Over the API `createEntity`, `createEntities`,
  `instantiatePrefab` and `pasteEntities` need a `sceneId` or a `parentId`:
  there is no default scene.
- **Moving between scenes**: drag objects onto another scene's header or
  rows in the hierarchy, or `moveEntities {entityIds, parentId, beforeId?,
  sceneId}`: they move with their children into that scene, ids (and so
  every reference to them) and world positions kept, one undo for both
  scene files.
- **Lights belong to scenes** ([Lighting](lighting.md)). Any scene may hold any light:
  at most one directional, one ambient and one hemisphere light and 16
  point/spot lights per scene. With scenes loaded together (start scenes in
  their listed order, then loads in order), the most recently loaded
  scene's directional light is on and the others are off; the same for
  ambient and hemisphere lights, each kind on its own (a scene with only a
  sun keeps the fill light below it). When that scene unloads, the previous
  one's light comes back. Point and spot lights of all loaded scenes share
  the budget of 16; past it the most recently loaded scenes' lights are on.
  The Scene view applies the same rule to the open scenes, in hierarchy
  order. Play diagnostics (`renderer.lights`) name the lights that are on.
- **Spot light cookies**: Inspector → Light → Cookie picks a
  texture the spot projects through its cone (three's `SpotLight.map`;
  white passes the light, black blocks it, colour tints it), in the Scene
  view, Play and the export, on WebGPU and WebGL 2. Directional lights take
  no cookie.
- **In the editor.** Each open scene is a header in the hierarchy.
  - Click a header to make that scene active. New root objects go into the
    active scene; a child goes into its parent's scene.
  - **+ Scene** creates a scene, which becomes the active one.
  - Double-click a header name to rename the scene.
  - ★ adds the scene to the start set, or takes it out.
  - 🗑 deletes a scene. It shows only on an empty scene.
  - × closes a scene in this browser. Closed scenes are listed under
    "open scene…". Which scenes are open is remembered per browser, not in
    the project.
  - Drag objects onto another scene's header to move them there (above).
  - An editor session loads up to 65 536 objects over all scenes.
- **Loading at run time.** Scripts get `ctx.scenes`:
  - `load(sceneId, {at?: [x, y, z]})` requests a load. The page fetches
    `scenes/<id>.json` and checks its digest; the scene joins at the next
    step boundary. `at` offsets its root objects.
  - `unload(sceneId)` removes the scene at the next boundary.
  - `reload(sceneId)` puts a loaded scene back as authored at the next
    boundary: its objects return where they were authored (where it was
    loaded with `at`), the copies its objects' scripts spawned go, its
    scripts start over (disposed and made again, as at the start: no
    `onDisable`/`onDestroy`, `onEnable` again), its sounds stop. Kept
    objects (their scripts too), `ctx.save`, the counters and the other
    scenes stay as they are; a kept player arrives at the scene's listed
    spawn as on a load. An unloaded scene loads; a scene being loaded is
    left to arrive. Like `unload`, it is refused for a scene holding a
    player that is not kept loaded. A UI button does the same with the
    engine action `{do: "engine", action: "reloadScene", scene?}` (absent
    scene: the active one); `{do: "engine", action: "loadScene", scene}` and
    `{do: "engine", action: "unloadScene", scene}` are `load` and `unload`
    for a button (refusals are logged like a script's).
  - `status(sceneId)` returns `unloaded`, `loading` or `loaded`.
  - `loaded()` lists the loaded scenes.
  - A loaded scene brings its colliders, script instances, tags and triggers.
    An unload releases them: colliders leave the physics world, scripts get
    `dispose`, meshes and textures are freed, and a model no loaded object
    uses any more is released.
  - Kept objects (Keep loaded) stay when their scene unloads: they belong to
    no scene from then on (as spawned copies), and loading their scene
    again does not bring a second copy. A kept object's reference to an
    object of a scene that went reads as empty (one Problems line per Play).
    The player is the one object that cannot go: a scene holding a player
    that is not kept does not unload. When a scene of the shell's scene
    list loads, however it was loaded, a kept player arrives at that
    entry's spawn (a transition or the list naming its own spawn wins).
  - A replay returns to the start scenes. A start scene unloaded and
    loaded again takes its kept objects back, so a replay keeps them.
- **Scene transitions**: a trigger's scene transition loads and unloads
  scenes when the character enters it and can name a spawn it arrives at
  (see [Scene transitions](gameplay.md#scene-transitions-impulses-facing-camera-tracking-looks-and-event-sounds)).
- **Game rules in scripts.** There are no level bounds or kill heights any
  more.
  - `ctx.world.transform(entityId)` reads any loaded object's position,
    rotation and scale this step, local to its parent (as the Inspector
    shows them; for an object without a parent that is its world
    transform). `ctx.world.worldTransform(entityId)` (or
    `transform(entityId, {space: 'world'})`) composes them up the parents:
    where the object is drawn. Under a parent scaled unevenly and turned,
    its scale is the length of each world axis (Unity's `lossyScale`).
  - `ctx.lifecycle.respawn(spawnId?)` puts the character back at a spawn.
  - `ctx.emit({kind: 'pose', entityId, rotation: {yaw, pitch, roll}, scale})`
    (transform phase, an entity the script owns; degrees, applied yaw then
    pitch then roll; `scale` is a number or `[x, y, z]`; either may be left
    out) turns or scales it — a spinning sign, a pulsing light. It is visual:
    colliders keep their shape.
  - A call the runtime refuses does not stop the run: `ctx.emit` returns
    false for a refused intent (a bad value, the wrong phase, an entity the
    script does not own, a second write of a channel in one step) and
    `ctx.debug.command` answers no calls for a refused declaration; each
    refusal is one Console line. `ctx.game.add` refuses (false, one line) a
    counter name a save cannot keep (a letter or _, then up to 31 letters,
    digits or _); a save holding such a name still loads the rest.
  - Play diagnostics (the Console, `tl_diagnostics`) fit 16 KiB: a long
    run's report drops its oldest log entries first and says how many
    (`trimmed.logEntries`). `physicsPenetrationCorrectedCount` counts steps
    the 3D character began inside a collider; `physicsDeepestOverlap` names
    the deepest one's entity pair.
  - Camera bounds are optional (Gameplay → Camera → "Keep the camera
    inside bounds").
- **Play and export** ship every scene file and load the others on demand.
  An exported game needs nothing else.
- **MCP.**
  - `tl_command createScene {name, sceneId?}`, `renameScene`,
    `deleteScene` (only an empty scene), `setStartScenes {sceneIds}`.
  - `createEntity`/`instantiatePrefab` take `sceneId` (or a parent: a
    create with neither is refused). `createEntity` takes every component
    `setComponent` adds, except those its `kind` makes (box, model).
  - `tl_inspect target="entities"` takes `sceneId` and names every entity's
    scene; `target="project"` lists the scenes.
  - `tl_game_control` takes `loadScene`/`unloadScene` with `sceneId`.
  - The game observation lists the loaded scenes.

## Preparing a scene, and scene transitions

A scene loaded during play is prepared before it appears:
its file, models, textures and instance buffers are read and parsed first,
so the frame that shows it shows all of it. The scenes a game is likely to
load next — the targets of the scene transitions in its loaded scenes and
the shell's next listed scene — are read ahead in the background (at most
four). A scene transition (a trigger's, a move along the shell's scene list,
or `ctx.scenes.load(id, {unload: [...]})`) keeps the scenes it unloads in
view until its scene is in, then swaps them in one step, so the view never
shows an empty world. Its optional `fade` (seconds, 0–5; `fadeColor`) fades
the view out before the swap and back in once the new scene is drawn; set it
in the Inspector under the trigger's Scene transition or on a scene list
entry. Scripts read the loading state with `ctx.scenes.loading()` and
`ctx.scenes.transition()`; UI documents with `$flow.scenes.loading`,
`$flow.scenes.scenes` and `$flow.scenes.transition.phase` (`out`, `loading`);
`tl_game_observe` shows `scenes.transition`, `preloading` and `preloaded`.
Each scene load in `startTimings.sceneLoads` also says whether it was read
ahead, when it was prepared, and the draw calls before it, of the frame that
attached it and the fewest in between.

## Cameras (virtual cameras)

A scene can hold **virtual cameras**: shots the game cuts or blends to.
Add one to any object with **+ Add component → Virtual camera** (Camera
group; presets: follow/orbit, orbit a point, top-down, fixed), or make one
with GameObject → Cameras → Camera.

**Which camera is live.** The enabled virtual camera with the highest
**Priority** (on a tie the one activated last, then the first in the scene).
**Enabled at start** off keeps a camera waiting for a script. Without an
enabled virtual camera the view holds the default pose (see
[the view](#the-view-cameras-and-kept-objects)).

**Rigs** (the **Rig** field; the Inspector shows the fields each uses):

- **Follow / orbit** — circles its **Target** at **Distance**, **Yaw** and
  **Pitch** (limits **Pitch min/max**), plus a **Target offset** (e.g. head
  height). The player turns it with the **Turn action** (an axis; a 2D axis
  turns with x and tilts with y), tilts it with the **Tilt action** and zooms
  with the **Zoom action** (between **Min/Max distance**). In a 3D project it
  is pulled in front of colliders between it and the target (**Collision**,
  **Collision radius**; never closer than Min distance). **Damping** lets it
  lag behind a moving target.
- **Orbit a point** — circles the **Point** (a world point with a Scene
  handle; absent: the target, else where it is placed). Each press of the
  **Turn left/right action** turns one **Turn step** (90° by default), eased
  over **Turn time**; tilt and zoom as above.
- **Top-down** — straight down onto its target from **Distance**, turned by
  **Yaw**.
- **Fixed / look-at** — where it is placed; with a target it looks at it.
- **Rail (path)** — rides a **Camera path** (another component: points as
  offsets from its object, drawn and dragged with the path handle; **Closed**,
  **Smooth**). **Progress** (0–1) is where it starts, **Rail speed** (m/s)
  how fast it rides, **At the end** stop, loop or back and forth. It looks at
  its target, or along the path.

**Blends.** When the live camera changes, the view moves from what is on
screen to the new camera: **Blend in** cut, linear or eased over **Blend
time** (back to the default pose: the camera being left sets it). A change
during a blend continues from the blended view.

**Lens and effects.** **Field of view**, **Near** and **Far** (absent: the
project's camera settings — a camera with a far plane of kilometres draws distant
scenery), **Letterbox** (black bars over the top and bottom, each that share
of the view height, blended with the camera) and a constant **Shake**
(amplitude, frequency, rotation).

**Depth precision.** Project settings → Rendering → **Depth precision**
(`depth_buffer`): Standard (the default), Logarithmic or Reversed Z. The last
two keep close objects sharp while scenery kilometres away still sorts
correctly; reversed Z needs WebGPU or a WebGL 2 browser with
`EXT_clip_control` and falls back to standard otherwise. The game canvas
reports the mode in `data-tl-depth`.

**Scripts** (`ctx.camera`, and the Camera nodes of visual scripts):
`activate(id, {blend?, time?})`, `deactivate(id, …)`, `setPriority`,
`setTarget`, `set(id, {distance, yaw, pitch, progress, railSpeed, fovY,
letterbox, point, targetOffset})`, `turn(id, steps)`, `shake(amplitude,
seconds, frequency?, rotation?, seed?)`, `live()`, `blending()`, `get(id)`,
`worldToScreen(position)` and `screenToRay(x, y)` (screen coordinates 0–1
from the top left, with the aspect of the view the game is drawn in).
Changes take effect at the end of the step; the camera is resolved in the
simulation step, so replays, the simulation worker and the export give the
same camera (and the same screen rays) bit for bit.

**Editor.** A selected virtual camera shows its frustum where its rig puts
it (the same maths as Play) and a line to what it looks at; the orbit point
and camera path points are Scene handles (one undo step per drag).

**Observing.** `tl_game_observe` (and `window.__thirdlightObserve()` in an
export) reports `camera: { live, blend: {from, progress, style} | null,
position, rotation, fovY, near, far, letterbox, shake }` while the game has
virtual cameras.
