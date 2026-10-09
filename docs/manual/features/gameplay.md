# Gameplay

The gameplay components (movers, triggers, switches, collectibles, health,
patrols, gravity, climb volumes, hitboxes), scene transitions, impulses,
facing, camera tracks and regions, look overrides, event sounds, and the
game shell. The idea: [the game shell](../concepts/game-shell.md); every
field: [Components: Gameplay](../reference/components-gameplay.md).

## Gameplay blocks

The GameObject menu's create entries come from the component descriptors
(each component's `create` list; MCP reads them with the
descriptors). In a v4 project: **Spawn point**; **Gameplay** → a one-way
platform (2D plane), a moving platform, a door (opens on the signal
`open`), a trigger, a scene transition (a trigger that moves the character
to another scene; needs a second scene), a switch (2D plane), an object
with health, a collectible, a patrolling object and a hitbox; **Cameras**
→ a camera track and a camera region; **Light** → a fog volume. A 3D project gets the 3D forms
(colliders, hitboxes and triggers with a depth). The hierarchy and Scene
view icons come from the descriptors too. Any object can get these in the Inspector
("+ Add component", Gameplay):

- **Mover** — a path of offsets from where the object stands (waypoints, x/y/z each),
  speed, ping-pong / loop / once, a wait at each stop, smooth easing, and
  "waits for signal" (a door or a lift that starts when a switch or trigger
  fires). With a box or polygon collider it carries the player standing on
  it and pushes a player it moves into (a polygon by its exact shape). A mover rising beside or under the player
  (a gate opening, a pillar) pushes the player aside, never up: only a player
  above it rides it up. The Scene view draws its path. More
  signals — **Stop on signal** holds it where it is, **Toggle on signal** moves
  a held mover and holds a moving one (with **Moving** off it waits for the
  first toggle), **Reverse on signal** turns it around (a finished once-mover
  goes back to its start); and a **gravity** easing: from rest at each point,
  speeding up evenly until the next (each stretch takes as long as at its
  speed). A script reads a signal's hold as `get('mover').active`.
- **Trigger** — an area that sends a signal when the player enters it
  (and, if set, another one when the player leaves it). Its shape is a box
  (width, height) or a circle (radius; tested against the player's capsule
  itself, not its bounding box); switching the shape in the Inspector
  replaces the size with a radius (1 m) and back. Mode "stay" sends the signal
  every step while the player is inside instead of once per entry. The
  Scene view draws a circle trigger as a circle with one handle that drags
  its radius (5 cm snapping, Shift for exact, one undo per drag).
- **Switch** — `interact` (the interact action while inside) or `stand`
  (a pressure plate); sends a signal.
- A collider's **one-way** flag: jump up through it, land on it from above,
  Down + Jump drops through. A spawn inside one is not blocked (the player
  drops to what is below).
- Colliders that share a face or overlap (a floor of tiles, a wall of
  stacked blocks, a slope cut in pieces) act as one surface for the 2D
  player: it does not stand on or catch at the seams between them.

A HUD document shows counters and health through its bindings (see [the game shell](#the-game-shell-menus-and-hud-as-ui-documents)). `tl_game_observe` reports `counters` and `health`. Scripts use
`ctx.signals.emit(name)` / `.on(name)` (seen the next step),
`ctx.game.counter(name)` / `.add(name, n)` / `.health()` /
`.setVisible(entityId, visible)` (until the next run; it still collides),
and `ctx.physics.raycast(origin, direction, maxDistance)`,
`.overlapBox(center, half)` and `.overlapCircle(center, radius)` (the
entities whose colliders overlap, never the player; 1,024 queries per step
in all, 2D and 3D).

### Generic primitives

Four components that work the same on the 2D plane and in 3D (the
Inspector's "+ Add component", Gameplay). They
carry no game rules: what a collected item, a hit or 0 health *means* is the
project's scripts' decision.

- **Collectible** — the character (the controller's object) touching its
  area (width, height and, in 3D, depth; default 1 m) adds **amount** to a
  named **counter** (any name), hides it, sends its **on collect** signal and
  comes back after **comes back after** seconds (0: never). Scripts:
  `ctx.collectible.collected(id)`, `ctx.collectible.restore(id)`.
- **Health** — on any object: **maximum** and **start**. Scripts:
  `ctx.health.get(id)` → `{current, max}`, `ctx.health.damage(id, n, source?)`,
  `ctx.health.heal(id, n)`, `ctx.health.events()` (every object's events of
  the last step). There is no grace time, knockback or death rule: a script
  decides what `died` means (for example `ctx.lifecycle.respawn()` and a
  heal).
- **Patrol** — the object walks by itself at **speed**: **Edge to edge**
  (straight ahead from its **start direction**; turns at a wall ahead or a
  ledge past its front, probing from its **body** box with the wall and ledge
  probe distances; needs the physics world) or **Waypoints** (offsets from
  its start, back and forth or a **loop**), waiting **wait** seconds at each
  turn. Scripts: `ctx.patrol.get(id)` → `{direction, active}`,
  `ctx.patrol.setActive(id, on)`, `ctx.patrol.turn(id)`. On the
  2D plane the start direction may point anywhere in the plane (a y part walks
  it up or down, turning at a wall that way; only a walk along the ground
  looks for ledges).
- **Gravity** — an object that is not a character (a patroller,
  an item, a prop without a collider) falls under the project's gravity
  (times its **scale**, capped at the project's fall speed) until its
  **body** (a box centred on it, 1 m by default) rests on a collider below;
  it falls again when the floor goes. An edge patroller with gravity walks
  off nothing it did not before but follows the ground's height. Not with a
  mover, a collider or a waypoint patrol. Saves keep its height and fall.
- **Climb volume** — a box (centred on the object, turned with
  it) the character climbs in: while its capsule's centre is inside, pushing
  up or down (the move action's up/down, or the controller's **Climb
  action**) takes hold and moves it along the box's up axis, sideways input
  moves it across, at the controller's **Climb speed** (2 m/s), with no
  gravity; a jump press lets go with a jump, and leaving the box lets go. A
  2D project whose move action is left/right only names an up/down axis as
  the controller's climb action. Scene-view size handle; GameObject →
  Gameplay → Climb volume.
- **Hitbox** — a box or sphere (a circle on the 2D plane). A hitbox touching
  another hitbox or the character sends both a `contact` event (the other
  object and the contact **normal**, a unit vector toward the other: `[0, 1,
  0]` when the other came from above) and a `separate` event when they part.
  An object never touches its own parents or children. **Damage** takes that
  much health from the other side (or its nearest parent with health) on
  each new contact. Scripts: `ctx.hitbox.setActive(id, on)`,
  `ctx.hitbox.touching(id)`.

Their events (`damaged`, `healed`, `died`, `collected`, `restored`,
`turned` with `wall`/`ledge`/`end`/`script`, `contact`, `separate`) arrive in
`ctx.events` in the step after they happened, for the objects a script owns
(its own, those below it, and those its object properties name). A save
schema's **components** section keeps health, collected collectibles,
patrollers and switched-off hitboxes. The play observation
(`tl_game_observe`) reports the named `counters` and every object's `health`.

### Scene transitions, impulses, facing, camera tracking, looks and event sounds

These work in both dimensions.

- **Trigger → Scene transition** (Inspector, a trigger's "+ add"): entering
  the trigger loads **Load scene**, unloads **Unload scenes**, and once the
  scene is loaded moves the character to **Arrive at** (a player spawn in
  that scene or the trigger's own; it becomes the spawn `ctx.lifecycle`
  respawns at). A trigger's `enter`/`exit` events reach the scripts that own
  it (`ctx.events`; `by` names the player that entered or left).
- **Character impulse**: `ctx.character.impulse([x, y, z], entityId?)` adds a velocity
  (m/s) at a player's next move (a push, a launch, a bounce; up lifts it
  off the ground; the 2D plane ignores z; absent id: the first player).
- **Facing**: Face movement **Face velocity** turns a model toward its
  motion in any direction (3D too; **Yaw offset** for a model authored facing
  another way; at the top of the hierarchy it follows its own motion). A
  player spawn's **Yaw** is the way the character faces on arrival (3D: the
  character turns; 2D: its face-movement models).
- **Switch → Action**: an interact switch reads the input action you name
  (default `interact`).
- **Virtual camera → Track (dead zone)**: keeps its placed rotation and
  follows its target at its placed offset (or **Offset**), moving only when
  the target leaves the **Dead zone** box, lagging by **Damping**, and keeping
  the framed point inside **Bounds min/max**. No fixed camera distance.
  **Look-ahead** frames that many seconds of the target's
  movement ahead of it, per axis (a vertical look-ahead `[0, t, 0]` shows the
  ground below a fall), capped by **Look-ahead max** (3 m) and eased by
  **Look-ahead smoothing** (0.2 s). With the camera selected the Scene view
  shows the dead zone around its target and the bounds box, each dragged by
  its grips (one undo step).
- **Camera region** (GameObject → Cameras → Camera region): a
  box on the world axes (no depth: every depth). While a track camera's
  target is inside, the camera uses the region's **Dead zone**, **Bounds**
  (from the region's position) and **Distance** (along its offset), each
  absent one keeping the camera's own; entering or leaving blends over the
  region's **Blend time** (0.5 s). **Camera** limits it to one track camera;
  overlapping regions: the highest **Priority**, then the one entered last.
  Scene handles for its size, bounds and dead zone. `tl_game_observe`
  reports the live camera's `region`.
- **Look overrides**: `ctx.look.set(id, {emissive, emissiveIntensity, tint})`
  glows and tints an object on both renderers until `ctx.look.clear(id)` or a
  new run (`ctx.look.get(id)` reads it; saved in the `components` section).
- **Event sounds** (Project Settings → Audio): rows that play a sound when a **signal** is
  sent (by name) or an **event** happens (`enter`, `exit`, `collected`,
  `damaged`, `died`, `contact`, … or an animator clip event's name;
  optionally only one object's), at a volume on a bus. The export carries
  their sounds. MCP: `setEventCues {cues}`.

### The game shell: menus and HUD as UI documents

The **Game shell** (Project Settings → Game shell; MCP: `setShell {shell}`) draws
the menus and HUD with the project's own UI documents (make them in the
project window: create ▾ → UI document):

- **Screens**: **Title** (shown before play; the game waits behind it),
  **Pause** (Escape / pad Start; absent: the engine's pause panel, Resume only),
  **Settings**, **Controls** (rebinding), **Save** and **Load**. Their buttons
  use engine actions: `resume` (from the title too: it starts play), `reloadScene`, `continue` (the newest save),
  `back`, `open` (a screen), `save` / `load` (slot 1–3, the project saves of
  Project Settings → Saves), `setSetting`, `rebind`, `nextScene`,
  `loadScene` / `unloadScene` (a scene), and the deprecated `quitToTitle`
  (see [Migration notes](migration.md#the-run-restart-and-the-engines-new-game-deprecated)).
- **HUD**: documents shown while the game plays. Bindings read
  `$flow.counters.<name>` (named counters: collectibles, scripts),
  `$flow.health.<objectId>.current|max`, `$flow.prompts` (made from the
  project's input actions, e.g. "A/D move x · E interact"), `$flow.shell`
  (screen, scene, `canContinue`, `saves.<n>.label`, `note`) and script values
  (`ctx.ui.set`).
- **Scene list**: the game's scenes in order, each with the spawn it starts
  at (a new game the game builds starts at the first; the deprecated `newGame`
  action restarts the run there, see [Migration notes](migration.md#the-run-restart-and-the-engines-new-game-deprecated)); **Next scene** loads the next
  and moves the character to its spawn.
- **Pause allowed**, and a debug **Status line** (screen, scene, prompts).

A save from the shell includes the named counters in the `components`
section and (save format version 2) which scenes are loaded and where
the character stands. `tl_game_observe` reports `shell {screen, scene, hud,
note}`.
