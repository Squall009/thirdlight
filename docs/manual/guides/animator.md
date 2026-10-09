# The animator

**Goal:** the player's model plays Idle, Run and an in-air clip, switched by
its speed and whether it stands on the ground, with short crossfades. Every
setting (layers, bone masks, blend trees, look-at, sockets):
[Animation](../features/animation.md).

An **animator controller** is a state machine: **parameters** (float, int,
bool, trigger), **states** that play a clip or a blend tree, and
**transitions** with conditions and a crossfade. An object's **Animator**
component names the controller. The game feeds `speed` (m/s), `grounded`,
`velocityY` and a `landed` trigger to an animator on a player (or on a model
under it) whenever the controller defines them.

## In the editor

1. Choose the model in the project window, then **create ▾ → Animator
   controller** (the new controller uses that model's clips). **Animator
   controller: character locomotion** makes idle/run/jump/fall/land states
   at once.
2. The controller opens as an **Animator** tab on the graph editor. On the
   left, add the parameters `speed` (float) and `grounded` (bool).
3. Add states (right-click, Space or **+ Node**): `Idle`, `Run`, `Air`, and
   pick each one's clip in the Inspector. Drag the **Entry** wire to `Idle`.
4. Drag transitions: Idle → Run with the condition `speed` greater than
   0.1, Run → Idle with `speed` less than 0.1, **Any State** → Air with
   `grounded` false, Air → Idle with `grounded` true. Set each crossfade in
   the Inspector (0.15–0.2 s).
5. **Preview** in the tab runs the controller on its model with the
   parameters as sliders; the states it is in are outlined.
6. Select the player model, **+ Add component → Animator**, pick the
   controller. **▶ play** and run.

## Through the API

1. The controller ([`setAnimator`](../reference/ops-detail.md#op-setAnimator),
   [`AnimatorController`](../reference/types-a-d.md#type-animator-controller)):
   ```json
   {"controller": {"controllerId": "hero", "name": "Hero",
    "parameters": [{"name": "speed", "type": "float", "default": 0}, {"name": "grounded", "type": "bool", "default": true}],
    "states": [
      {"id": "idle", "name": "Idle", "motion": {"kind": "clip", "clip": {"assetId": "starter-character", "clip": "Idle", "duration": 1}}, "speed": 1, "loop": true},
      {"id": "run", "name": "Run", "motion": {"kind": "clip", "clip": {"assetId": "starter-character", "clip": "Run", "duration": 0.4}}, "speed": 1, "loop": true},
      {"id": "air", "name": "Air", "motion": {"kind": "clip", "clip": {"assetId": "starter-character", "clip": "Airborne", "duration": 0.6}}, "speed": 1, "loop": true}],
    "transitions": [
      {"from": "*", "to": "air", "conditions": [{"parameter": "grounded", "op": "false"}], "duration": 0.15},
      {"from": "air", "to": "idle", "conditions": [{"parameter": "grounded", "op": "true"}], "duration": 0.15},
      {"from": "idle", "to": "run", "conditions": [{"parameter": "speed", "op": "greater", "value": 0.1}], "duration": 0.2},
      {"from": "run", "to": "idle", "conditions": [{"parameter": "speed", "op": "less", "value": 0.1}], "duration": 0.2}],
    "entry": "idle", "events": []}}
   ```
   `"from": "*"` is Any State. A clip is named by the model asset and the
   animation's name in the model file, with its length in seconds; the
   editor's clip picker lists them.
2. Put it on the model ([`animator`](../reference/components-animation.md#component-animator)):
   `setComponent {"entityId": "<player model>", "component": "animator", "value": {"controller": "hero"}}`.
3. Play, send input that walks (`move` held), and observe with the model's
   `entityId`: `animators` names each animator's state (`Run` while
   walking, `Idle` after) and `animator` gives the clips and their weights.
4. Graph changes later go through [`graphEdit`](../reference/ops-detail.md#op-graphEdit)
   `{"owner": {"kind": "animator", "id": "hero"}, "ops": [...]}`; the node
   ids are the state ids plus `ENTRY` and `ANY`.

Scripts drive any parameter: `ctx.animator(id)?.set('speed', 2)`,
`.trigger('attack')`, `.state()`, `.setSpeed(0.5)`
([`ctx.animator`](../reference/script-api.md#ctx-animator)).

## Which to use

Build controllers in the editor: the graph and the live preview show what a
transition does, and timing is judged by eye. Use the API to make many
similar controllers (one per enemy type from a template) or to check a
controller in a test by observing its states in Play.

## Pitfalls

- **Transitions are checked in order.** A pair with several transitions
  shows **×n** on its wire; the first whose conditions hold wins.
- **Automatic parameters only reach the player's animators**, and only the
  names the controller defines (`speed`, `grounded`, `velocityY`,
  `landed`). Any other object's animator needs a script.
- **A clip must be one of the model's** (or of an animation-only file set
  as **clips for rig of** that model).
- **Up to three override layers** on top of the base layer; an override
  layer's **Empty state** lets the layers below show through.
- **Animators step with the simulation:** a replay shows the same poses.
  Morph weights are presentation only.

Related: [sockets and look-at](../features/animation.md#sockets-objects-on-model-nodes),
[scripts](scripts.md).
