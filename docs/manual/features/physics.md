# Physics

The player's collision capsule, where the simulation runs (worker or
page), 3D physics and the 3D character. Choosing 2D or 3D:
[2D and 3D](../concepts/2d-and-3d.md). Every collider and controller field:
[Physics components](../reference/components-physics.md).

## The player's collision capsule

The player (the object with the controller) collides as an upright capsule.
Select it: the Player controller section's **Collision** group shows the capsule's radius,
height (end caps included, at least twice the radius) and offset (where the
capsule's centre sits relative to the object's origin). Without an own
capsule it uses the default — radius 0.3 m, height 1.8 m, centred. **Fit to model** sizes it to the player's
model and its children's models (their height, half the smaller of width and
depth, the feet at their lowest point); **Default** goes back to the default.
Objects under the player show "collides with its parent's capsule".

The Scene view draws the capsule in the collider colour (Gizmos → collider
outlines); clicking its outline selects the player. While the player is
selected, white handles on the capsule's top and side drag its height (the
feet stay where they are, so the offset follows) and its radius — one undo
step per drag, sizes snap to 5 cm with snapping on (hold Shift for exact
sizes). Every other sized object has handles too — see [Scene handles](editor.md#scene-handles).

Everything uses the capsule: physics (walls, ceilings, slopes, one-way
platforms), spawn and respawn placement (the object's origin goes to the
spawn marker; with the offset at half the height the origin is the feet, so
a spawn on the ground puts the feet on the ground), collectibles, hitboxes,
triggers, switches and moving platforms' push-out. MCP: `setComponent` `controller`
`{capsule: {radius, height, offset?} | null}`; `tl_inspect` shows it.

## Simulation thread (worker)

The game's simulation — the runtime with its fixed steps,
Rapier physics, the gameplay blocks, animators, timers, spawns, effect and
sound requests, and the project's scripts — runs in a dedicated **worker**,
in Play and in exported games. The page keeps what needs the page: input
(keyboard, pads; sampled once per frame and sent with the frame), sound (the
worker sends the sound requests; the page's audio owner plays them), the
HUD, menus, the game shell and saves (browser storage), and rendering (the worker
sends each frame's interpolated transforms, visibility, fades, animator
poses, counters and effect requests). A long simulation step does not
delay a frame or an input event. Results are identical to running in the
page: the same fixed steps with the same inputs (a test compares a digest of
every step's state in both modes), recorded replays and bots included.

**Where it runs.** In this order:

1. the page URL flag: `?threads=off` (also `single`, `main`) forces the page's
   main thread, `?threads=on` (`worker`) the worker — on the editor's URL it
   is passed on to Play (like `?renderer=`); on an exported game's URL it
   applies directly;
2. the project setting **Engine → Simulation thread** (`sim_thread`: Worker /
   Main thread);
3. otherwise the worker.

A browser that cannot start the worker (no `Worker`, a blocked script) plays
in the page instead. Every Play and export page logs its choice to the
console, e.g. `[thirdlight] simulation: worker (the default); transforms by
messages (cross-origin isolated: no)`; `tl_game_observe` and
`tl_diagnostics` report it as `simulation: { mode, transport, isolated }`,
and an exported page has it in `window.__thirdlightThreading`.

**Files.** Play loads the worker from the preview origin (`/sim-worker.js`,
built next to the preview bundle; the preview CSP allows `worker-src
'self'`). An export ships it as `js/sim-worker.js` next to `js/main.js`;
Rapier's WebAssembly is inside that bundle (no fetch, no URL), and the export
scan checks it like the main bundle. The compiled scripts are imported by
the worker from the same `behaviors/<digest>.js` files the page would use.

**Shared memory (optional).** The per-frame transforms go as messages
(transferred typed arrays; only the entities that moved when few did). Where
the page is *cross-origin isolated* they go through a `SharedArrayBuffer`
instead — the same results, one copy less per frame:

- *Exported games:* serve the game with
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (every file of the export is
  same-origin, so nothing else is needed). Without these headers the game
  works exactly the same with messages.
- *Play:* start the backend with `THIRDLIGHT_CROSS_ORIGIN_ISOLATION=1`. The
  editor page and every preview-origin response then carry COOP + COEP (the
  play page also `Cross-Origin-Resource-Policy: cross-origin`, as it is
  embedded by the editor). Off by default: it changes how the editor page is
  isolated (a cross-origin resource the editor would load without CORP
  headers would be blocked), and Play works the same without it.

**Limits.** The physics engine's WebAssembly memory may grow to
512 MiB (`PHYSICS_MEMORY_CAP_BYTES`, an engine limit far above any 2D level);
past it the worker stops the simulation with `physics_memory_limit` instead
of growing without bound. Stopping Play (or leaving an exported page) frees
the worker's runtime and Rapier world before the worker ends. The physics
query budget (32 rays and overlaps per step) and overlap queries are the
same in the worker.

**What stays different.** Commands from the page (a level switch, pause, a
scene load, run start/replay) reach the worker in order and apply at its next
step boundary, as in the page; a level switch the worker refuses is logged
(`simulation worker refused startLevel …`) instead of being refused
synchronously. The page never waits for the worker: each frame it applies
the newest finished worker frame, sends the next tick (with this frame's
input) and draws at once, every object blended between its last two finished
steps, so the picture is one frame behind the simulation and a key press
reaches the screen one frame later than in single-thread mode (Play's
`inputToDrawMs`, about 17 ms at 60 fps; an e2e test measures it).

**Measuring.** `node tools/perf/run.mjs --surfaces play,export --threads
worker,off` measures Play and the export in both modes; the report adds the
page's main-thread task time per frame (`mainThread`).

**Rendering stays on the page.** A render worker (the canvas moved to an
`OffscreenCanvas` in a worker) was built, measured and not
adopted: on the CPU-rendered test host it freed the page's main thread but
drew no more frames, and it showed unexplained stalls on WebGPU (numbers in
`docs/plan-phase-22.md` §5; the spike is kept in
`archive/spike-22-render-worker/`). Real-GPU measurements are pending.

## 3D physics (physics dimension)

A project chooses its simulation's dimension in the project
settings: **Engine → Physics** (`physics_dimension`): **2D plane** (the
default, and what a project without the setting gets — movement and
collision in X and Y on the Rapier 2D backend) or **3D** (the Rapier 3D
backend, `@dimforge/rapier3d-compat` 0.20.0).

In a 3D project:

- every box collider needs a **depth**: the collider's **Half depth** field
  (`hz`, metres; its Scene handle becomes a 3-axis box that turns with the
  object once the depth is set). Switching a project to 3D is refused while a
  box has none; polygon colliders are 2D-plane shapes and are refused too;
- a collider's **Shape** may also be a **sphere** (radius), a
  **capsule** (radius and total height, standing along the object's Y), a
  **convex hull** (up to 64 points) or a **triangle mesh** (up to 1,024
  vertices and 2,048 triangles; static level geometry — never on a mover).
  Hulls and meshes are made from a model: dragging a model with a `_COL`
  node into a 3D project gives it a mesh collider from that node (a convex
  hull when it is too big for a mesh), and the Inspector's **Box / Convex
  hull / Mesh from model** buttons make one from the object's model (its
  `_COL` node(s), else its LOD0 geometry). A 3D collider takes its object's
  scale (any positive scale for a box, hull or mesh; uniform for a sphere or
  capsule). The Scene view draws every 3D collider as a wire outline; a
  sphere has a radius handle, a capsule a height and a radius handle.
  "+ Add component" offers the 3D presets (Box (3D), Sphere, Capsule, Convex
  hull, Mesh) in a 3D project and the 2D ones in a 2D plane;
- **triggers** are 3D volumes: a **box** with a depth (`size` [w, h, d]),
  a **sphere** or a **capsule** (radius and height), turned with their
  object and tested exactly against the player's capsule — enter and exit
  signals, `mode: stay`, `once` and scripts' trigger events work as in 2D.
  Switches are 2D-plane blocks and are refused in a 3D project; one-way
  colliders too;
- **movers** move 3D colliders (box, sphere, capsule, hull) along their
  waypoints and carry the player standing on them; a script may drive a
  collider no mover moves through its transform intents (the runtime turns
  it into a moving body; the player standing on it rides along);
- colliders may be rotated about any axis; the player controller stays
  upright; the capsule's **Offset** may have a z component;
- every collider shape takes a `center` ([x, y, z]; a plane reads x and y)
  and a `rotation` (a quaternion [x, y, z, w]; about Z only on a plane),
  placed in the object's space; `{type: "compound", shapes: […]}` is a list
  of primitives on one body (no nesting); `{type: "model"}` is every mesh
  under the object's model's `<piece>_COL` node(s) as a convex hull of up to
  64 points, read from the file when the game is built (the manifest's
  `modelColliders`; Draco or flat parts are left out and Play/export warn
  `collider_model`). A turned shape under an uneven scale is built from its
  moved points (a box becomes its corners' hull);
- colliders on child objects (not on the controller, not a mover's own
  collider) sit where their parents put them: static, or kinematic and
  posed every step once the object or a parent is moved by a script owning
  its transform, a timeline's transform track or a mover — they then push
  the player as a mover does (a mesh collider stays static, one log line).
  In 3D with the controller a push can leave the player about 0.1 m inside
  (a known defect). On the 2D plane children's colliders are placed at load;
- `colliderFromModel {entityId, kind: box | convex | mesh | polygon |
  compound}` (MCP/HTTP) is what the Inspector's model collider buttons do
  (**Compound of _COL parts** included): one `setComponent`, one undo;
- in Play and the export the player is a kinematic **3D character**
  (below; cameras: [Cameras](scenes-and-cameras.md#cameras-virtual-cameras));
- `tl_game_observe` reports such a play with `state: "running"`, its
  step and `player: { x, y, z }`; an exported page has the same observation
  in `window.__thirdlightObserve()`.

### The 3D character

The object with the **Player controller** walks, runs, jumps and climbs in a
3D project. Its settings are fields of the controller (Inspector, 3D projects
only; the 2D plane's Autostep is hidden there), each with a default that fits
any genre:

- **Movement:** Walk speed (2 m/s), Run speed (absent: the project's run
  speed setting — used while the `run` input action is held), Acceleration /
  Deceleration (shared with the 2D controller), Air control (0.5: the share
  of acceleration in the air), Gravity scale (× the project's gravity), Turn
  speed (720°/s; 0 turns at once) and Face movement (on: the object turns
  about its up axis so its +Z faces where it moves — its model turns with it),
  **Move relative to** (`moveFrame`: **Camera** `view`, the default — pushing
  up walks away from the live camera, world axes while no camera is live; or
  **World axes** `world` — up pushes along −Z and right along +X whatever the
  camera does);
- **Jump:** Can jump (on), Jump speed (absent: the project's jump velocity),
  with the controller's coyote time, jump buffer and jump release;
- **Collision:** Slope limit (absent: the project's max slope setting),
  **Step-up height** (0.3 m, a stair riser — steps up to it are climbed
  without a jump, taller blocks stop the character; 0 turns it off; the
  ground snap is at least this height, so it also walks down stairs without
  falling), **Ledge climb** (off; when on, pushing against a ledge up to
  **Ledge height** (1.2 m) with a walkable top and room for the capsule pulls
  the character up onto it over **Climb time** (0.6 s)).

The step-up and ledge heights have Scene-view handles above the capsule's
feet (drag up or down; 5 cm snapping; one undo).

**Climbing and walls** (both dimensions, the player controller's
group of that name): **Climb speed** and **Climb action** (see Climb volume);
**Wall slide** (off; when on, falling in the air while pushing into a wall
slides down it no faster than **Wall slide speed**, 2 m/s) and **Wall jump**
(off; when on, jump in the air next to a wall it touches — or touched within
the coyote time — pushes it off at **Wall jump away** (absent: the run speed)
and **Wall jump up** (absent: the jump speed); the input does not steer for
**Wall jump lock** seconds — absent: until the top of that jump; a landing
ends it). Both are off unless turned on.

**Input.** The move is a 2D vector: a project without its own input actions
gets the 3D defaults (W/A/S/D and the arrow keys or the left stick move,
Shift or the left-stick press runs, Space jumps); a project's own `move`
action moves in 2D when it is a 2D axis (a 1D `move` only moves sideways).
The vector is read relative to the active virtual camera's yaw (see
[Cameras](scenes-and-cameras.md#cameras-virtual-cameras): forward walks away from the camera); a scene without virtual
cameras walks along world axes (+x input along +X, forward along −Z).
`tl_input_exercise` frames take an optional `moveY` (the forward axis) and
named `actions` (e.g. `run`).

**Scripts** can drive the character with intents (intent phase): `{ kind:
'character_move', x, z, run? }` walks it along a world direction this step,
`{ kind: 'character_place', position: [x, y, z] }` teleports it,
`{ kind: 'character_enable', enabled }` switches the controller off (it stays
where it is: no input, no gravity) or on, and `control_move` takes an
optional `y` (the forward input). `ctx.physics.characterState(id)` reads its
position, velocity, grounding, contacts, whether it is on and climbing, and
its facing. These intents are refused in a 2D-plane project. A recorded
input replays the same positions in the page, the simulation worker and the
export.

**Files.** Each physics backend is a separate script, so a game downloads
only the one of its dimension: Play loads `/physics-3d.js` from the preview
origin for a 3D project; an export ships only its own, `js/physics-2d.js` or
`js/physics-3d.js`, with rapier's WebAssembly beside it as its own file
(`js/physics-2d.wasm` / `js/physics-3d.wasm`; the 3D one 1.4 MB, 0.5 MB
gzipped), fetched when the physics starts, and lists the
`@dimforge/rapier2d-compat` or `rapier3d-compat` license. The backend loads in
the simulation worker or, single-threaded, in the page, and registers itself
through game-host's dependency-free `physics-global` module; an export's page
and worker scripts carry no physics of their own.
