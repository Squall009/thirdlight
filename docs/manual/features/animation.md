# Animation

Animator controllers (states, transitions, blend trees, layers and bone
masks, look-at), and sockets: objects riding on a model's nodes. Step by
step: [the animator guide](../guides/animator.md). Each node of the animator
graphs: [Animator layer](../reference/graph-animator.md).

## Animator controllers

Models with clips (skinned or not) play them through **animator
controllers**: parameters (float, int, bool, trigger), states that play a
clip or a 1D blend tree, transitions with conditions, crossfade and exit
time, an entry state, and clip events. The project window lists the
controllers (`t:animator`); choose the model whose clips a new controller
uses, then Create → **Animator controller** or **Animator controller:
character locomotion** (idle/run/jump/fall/land states from a model's clips,
driven by the character's speed, grounded, velocityY and landed); a
controller opens in the editor window as **Animator: <controller>** with a
double-click (a new one opens by itself). The Inspector's "+ Add component" →
**Animator** puts a controller on a model object.

**The Animator editor** shows a layer's state machine on the node-graph editor
(all its gestures work, see [Graph editing](editor.md#graph-editing)):

- **Nodes**: one per state — **State** (plays a clip), **Blend tree**, and on
  override layers **Empty state** — plus the fixed **Entry** (its one wire
  goes to the state the layer starts in; drag a new wire from Entry to
  change it) and **Any State**. Add states with a right click, Space or
  **+ Node** (a new state plays the model's first clip until you pick one);
  Delete removes the selected states (Entry and Any State stay; deleting the
  entry state makes the first remaining state the entry).
- **Transitions**: drag from a state's output (or Any State's) to another
  state's input (a state may also go to itself). One wire stands for every
  transition between that ordered pair; a pair with several shows **×n** on
  the wire. A new wire starts as one transition at exit time 1 with a 0.1 s
  crossfade; deleting the wire removes the pair's transitions.
- **Inspector** (right dock): a selected state shows its name, clip (or the
  blend parameter and **Open blend tree**), speed and its × parameter, loop,
  **Set as entry state**, its clip events and the transitions leaving it
  (click one to select its wire). A selected wire lists its transitions in
  the order they are checked (↑ reorders): conditions, crossfade, exit time,
  interruption; **Add transition** adds another between the same states.
  Tab onto a wire's handle (the dot in its middle) to select it with the
  keyboard.
- **Blend trees** open as their own graph (double-click the node's body, or
  **Open blend tree**): one **Clip** node per blend clip (threshold and clip
  in the Inspector; clips stay in threshold order) feeding the fixed
  **Blend** node; the path above the graph (**Base layer › Blend tree:
  …**) leads back.
- **Layers** are the tabs above the graph; **Parameters** and, on an
  override layer, the layer's settings are on the left.
- **Live preview**: a pane inside the tab (the **Preview:** buttons dock it
  **Right**, at the **Bottom** or **Hide** it; remembered in the browser).
  **Preview** runs the controller on its model with the parameters as
  sliders, checkboxes and trigger buttons (nothing is saved); the states it
  is in are outlined in the graph.

Every gesture is one command and one undo step (Ctrl+Z works while the tab
is in front): graph gestures (states, wires, moves, groups, comments) are
`graphEdit` on the controller, the rest (transition details, parameters,
layers, events, the name) `setAnimator`. Positions, groups, comments and
collapsed nodes are stored in the controller (editor-only: exports drop
them); a controller without them (older projects, or made by MCP) opens
with an automatic layout, columns by distance from the entry state.

The game steps animators with the simulation (deterministic; a replay looks
the same). An animator on the player (or on a model under the player) gets
`speed` (horizontal m/s), `grounded`, `velocityY` and a `landed` trigger
automatically, when its controller defines them. Scripts use
`ctx.animator(entityId)?.set(name, value)`, `.trigger(name)`, `.state()`;
clip events of the previous step are in `ctx.events`. MCP: `setAnimator` /
`deleteAnimator` through `tl_command`, or the graph ops through `graphEdit
{owner: {kind: "animator", id}}` (id `<controllerId>` = the base layer,
`<controllerId>@<n>` = override layer n, `<controllerId>#<stateId>` = a blend
tree; the node ids are the state ids, `ENTRY`, `ANY` and, in a blend tree,
`OUT` and `C0`, `C1`, …) — it changes the controller exactly as
`setAnimator` would (one undo step); `tl_game_observe` reports each
animator's current state.

**Layers and bone masks.** "Add layer" (the layer tabs above the graph) adds an
override layer — up to three — on top of the base layer, e.g. an attack
played by the upper body while the legs keep running. Each layer has its own
states, transitions and entry state and shares the controller's parameters
(a trigger reaches every layer that tests it in the same step). The panel
left of its graph sets the name, the weight (0–1, optionally times a float parameter, so
a script can fade the layer in and out) and the **bone mask**: a checkbox per
bone of the model's skeleton ("+ children" takes a bone and everything under
it; no bone picked = every bone). A layer state may be **empty** (right
click → **Empty state**): the layer plays nothing and the layers under it
show through, so the usual layer is Empty → Attack (on a trigger) → back to
Empty at its exit time. A masked bone that the layer's clip does not animate
goes to its rest pose while the layer plays. `tl_game_observe` reports the
states as `Run | Upper body: Attack`; scripts read a layer's state with
`ctx.animator(id)?.state(1)`.

**Animation-only files.** A GLB with bones and clips but no mesh imports as
a model asset. Choose it in the project window and set **clips for rig of**
to the model it animates: its clips then appear in the Animator's clip lists
for that model (as `clip · file`) and play on it, matched by bone names (the
field reports animated bones the rig does not have; those stay still). MCP:
`setAssetOptions {assetId, clipsFor: rigAssetId | null}`.

**Older projects' idle/run/airborne animation.** A model object that still has the
old `modelAnimation` profile keeps playing it until the project is opened
again; on open it becomes an animator controller "Idle/run/airborne
(<model>)" (the same three clips, airborne while not grounded, else run
above 0.05 m/s, else idle, 0.2 s crossfades), written as one new revision.
If a clip length cannot be read from the model file the old component stays
and keeps playing.

## Sockets (objects on model nodes)

An object can ride on a named node — a bone or any node —
of another object's model: equipment in a hand, a rider on a mount, a pilot
in a cockpit, a flash at a muzzle. Select the object and **+ Add component →
Socket**: **Target** is the object whose model carries the node, **Node** is
picked from that model's node list (read from its GLB, the names the game
uses), and **Offset** / **Rotation offset** / **Scale** place it relative to
the node. **Attached at start** off keeps the socket as data a script
attaches later.

The simulation places attached objects at the end of every fixed step,
after the animators, so an object follows the target's animation (its
animator's clips, blends, crossfades and layers, the way the renderer poses
the model) and replays, the simulation worker and the export agree bit for
bit. The object's own children ride along. An object on a socket cannot be a
physics body (collider, controller, mover) or the scene camera; a script's
transform writes on it are overridden while it is attached. Works in 2D and
3D projects.

**Scripts** (`ctx.sockets`): `attach(entityId, targetId?, node?, position?,
rotation?, scale?)` (no target: the object's own Socket component),
`detach(entityId, keepWorld = true)` — it stays where the node left it, or
snaps back to its transform from before the attach with `false` —,
`attachedTo(entityId)` (`{target, nodeName}` or null) and `nodePose(targetId, node)` (a node's world
position and rotation now, e.g. where to spawn a projectile). A refused
attach (an unknown node, a loop, a physics body) returns false and writes a
warning to the play log. Visual scripts have the same nodes under
**Sockets**.

**How the game knows the nodes.** The runtime never loads models, so a
project that uses sockets (a Socket component anywhere, or a script naming
`ctx.sockets`) gets each model's **rig** — its nodes and the node animation
channels of its clips — read from the GLB into the play/export build (the
manifest's `rigs`). Engine limit: 262,144 key numbers per model, its
animation-only files included (clips past that are left out and a socket on
them warns once); no budget is shared across the project. A project using neither sockets nor look-at ships no rigs.

**Animation speed and morph targets.** `ctx.animator(id)?.setSpeed(x)`
sets one object's playback speed (every clip and crossfade; 1 as authored,
0.5 half speed, 0 holds the pose; 0–10) — slow motion for a prompt, an
animation-speed setting; `.speed()` reads it. The Animator's live preview has
a **speed** slider that plays the controller the same way. A controller's
**morphs** list (MCP `setAnimator`: `morphs: [{target, parameter}]`) drives a
morph target (blend shape) by a float parameter (clamped to 0–1);
`ctx.animator(id)?.setMorph(name, weight)` / `.morph(name)` set and read any
morph target from scripts. Morph weights are presentation: the renderer
applies them to every mesh of the model that has that target.

**Ground speed in a blend tree.** A blend clip may carry the **ground
speed** (m/s) it was authored for (the blend clip Inspector; MCP
`children: [{threshold, clip, speed}]`). With a speed on every clip of the
tree, the tree reads its parameter as a ground speed and scales time so the
blended clips cover exactly that speed — below the first threshold (a slow
walk plays the walk slower), between thresholds and past the last one
(Unity's homogeneous speed). Clip i plays at the rate that makes
Σ wᵢ·sᵢ·(its seconds per second) equal the parameter. A tree with a speed on
only some clips plays as authored. Where the blended speed is 0 (a standing
clip alone) the tree plays as authored too.

**Start time.** The `animator` component's **start time** (0–1, normalized)
starts every layer's entry state part-way; **random start** draws it from
the game's seed (the `random_seed` setting and the object's id), so a crowd
of copies does not breathe in step and a replay, a scene reload or the
export starts each copy at the same place. Scripts start a state part-way
with `ctx.animator(id)?.play(state, fade?, layer?, time?)` (Unity's
`Animator.Play(state, layer, normalizedTime)`; layer 0 is the base layer).
`tl_game_observe` with an `entityId` returns that object's animator pose
(`animator: {state, clips: [{clip, time, weight}], layers?, look?}`) and
its model's bones as drawn (`renderedBones: {name: {position, rotation}}`).

**Look-at.** The `animator` component's **Look at** turns the head
(optionally the neck and the chest) toward a **target** object or a world
**point** after the clips pose them (Unity's Animation Rigging multi-aim).
Each bone of the chain has a yaw and a pitch limit (degrees each way;
picked from the object's own model in the Inspector); the turn is split
over the chain in proportion to the limits, so the head ends facing the
target when it is within their sum and stops at it otherwise. Angles are
measured in the model's space from its front (+Z, the glTF front) at the
head bone as the clips pose it. The **weight** (0–1, optionally times a
float controller parameter) scales the turn, and the head moves at the
**turn speed** (degrees a second, 360 by default) toward a new target and
back when the weight drops to 0 or the target goes. Scripts:
`ctx.animator(id)?.setLookTarget(entityId | null)`,
`.setLookPoint([x, y, z])`, `.setLookWeight(w)`. The constraint is
simulation state (a replay turns the head the same way; sockets on the head
follow it); a project using it ships its models' rigs in the build, as one
with sockets does.

**Observing.** `tl_game_observe` (and `window.__thirdlightObserve()` in an
export) reports `sockets: [{ entityId, target, node, position }]` (the
drawn world position) while something rides on a socket.
