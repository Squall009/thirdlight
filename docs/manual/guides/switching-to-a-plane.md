# Switching to a plane and back

**Goal:** a 3D level where the player walks into a pipe and the game turns
into a side-view stretch: the player and the stretch's moving parts are
locked to a plane, the camera blends to a side view, the player crosses a
pit on a moving platform and jumps up through one-way platforms onto a
wall, then leaves through a second pipe back into free 3D. Nothing is
loaded or rebuilt at either switch. Background:
[2D and 3D](../concepts/2d-and-3d.md); the calls:
[`ctx.physics`](../reference/script-api.md#ctx-physics),
[`ctx.character`](../reference/script-api.md#ctx-character),
[`ctx.camera`](../reference/script-api.md#ctx-camera).

The engine gives the primitives: a body or a player character locked to an
axis-aligned plane (normal world X or Z) and freed again at any step, and
cameras a script activates. Which objects lock, when, and what the camera
does is your game's script.

## The level

Start from the **3D starter** (a player with a follow camera on block
ground). The stretch runs along world X at z = 0, the plane of the side
view:

- **The floor:** a block layer (cells of 1 m), 4 m deep along Z, with a pit
  6 m wide. Past the exit, the same layer widens into a 16 × 16 m yard of
  free 3D ground.
- **The pit:** a box (2 × 0.5 × 2 m) with a collider and a mover:
  `{"waypoints": [[-4, 0, 0]], "speed": 2, "mode": "once", "startOn": "ride"}`,
  resting flush with the near edge, and a trigger above its rest
  (`{"size": [1.6, 2, 2], "signal": "ride", "once": true}`): it starts when
  the player steps on and stops flush with the far edge.
- **One-way platforms:** boxes with a collider `{"shape": {"type": "box",
  "hx": 1.5, "hy": 0.1, "hz": 1}, "oneWay": true}`, their tops at 1 m and
  2 m, leading up onto a 2 m block wall.
- **Two pipes:** each two posts and a lintel (boxes with colliders), and a
  trigger between them: `{"size": [1, 2.2, 2.8], "signal": "pipe-in"}` at
  the entry, `"pipe-out"` at the exit.
- **The section tag:** a tag `section` (**File → Project Settings… → Tags**, or
  [`setTags`](../reference/ops-detail.md#op-setTags)) on the moving platform
  and the one-way platforms: the script locks what carries it.
- **The side camera:** a virtual camera, rig *Follow / orbit*, target the
  player, target offset [0, 1.5, 0], distance 14, yaw 0 (it looks along −Z,
  across the plane), pitch 6, damping 0.15, collision off, **Enabled at
  start** off, priority 20.

## The script

On an object of its own (an empty group), with **Side camera** set to the
side camera:

```ts
import type { BehaviorContext } from '@thirdlight/runtime';

export const properties = {
  side_camera: property.entityRef(null, { tooltip: 'The side-view camera' }),
  depth: property.number(0, { tooltip: 'Where the side-view plane lies along world Z (m)' }),
};

interface State { side: boolean }

export default {
  instantiate(): State {
    return { side: false };
  },
  step(state: State, ctx: BehaviorContext): void {
    if (ctx.phase !== 'intent') return;
    const camera = ctx.properties.side_camera as string;
    if (!state.side && ctx.signals.on('pipe-in')) {
      state.side = true;
      const plane = { axis: 'z' as const, origin: ctx.properties.depth as number };
      ctx.character.setPlane(null, plane);
      for (const id of ctx.tags.query(ctx.tags.mask('section'))) ctx.physics.setPlane?.(id, plane);
      ctx.camera?.activate(camera, { blend: 'eased', blendTime: 0.6 });
    } else if (state.side && ctx.signals.on('pipe-out')) {
      state.side = false;
      ctx.character.setPlane(null, null);
      for (const id of ctx.tags.query(ctx.tags.mask('section'))) ctx.physics.setPlane?.(id, null);
      ctx.camera?.deactivate(camera, { blend: 'eased', blendTime: 0.6 });
    }
  },
};
```

- `ctx.character.setPlane(null, plane)` locks the first player character:
  at the next step boundary it is snapped onto the plane (its z set to the
  plane's), its speed along the normal dropped, and from then on it walks,
  jumps and is pushed only along the plane. `null` frees it where it
  stands.
- `ctx.physics.setPlane(id, plane)` does the same for any object with a
  collider: a mover is posed on the plane, a static collider snapped onto
  it.
- The `state.side` flag makes each switch happen once, whichever trigger
  the player crosses again.
- Both switches land in the same step as the camera change: the player
  never moves along Z while the view is already side-on.

## The camera

`activate` brings the side camera in front of the follow camera (priority
20 over 10) with an eased 0.6 s blend; `deactivate` hands the view back to
the follow camera with the same blend. The follow rig keeps the player
framed as it walks; a *Track* rig with bounds is the other choice for a
stretch whose ends the view should not pass. A game mode can carry the side
camera instead (its **Camera**), when the stretch also changes the input
or the UI (below).

## Input

The 3D starter's player moves **relative to the live camera** (controller
**Move relative to** *Camera*). The side camera looks along −Z, so A/D (the
arrow keys, the stick) walk along the plane in the side view with no change
to the controls; W/S push along the plane's normal, which the lock drops.
Space jumps in both. Back in 3D the same keys walk in all directions again.

A game whose stretch reads other keys (Up to jump, a run on the stick's
press) puts them in an input map of their own and switches maps with a
[game mode](game-modes.md): a mode `side` with `"inputMaps": ["gameplay",
"side"]` and `"camera": "<side camera>"`, and the script calls
`ctx.modes.switch('side')` at the entry and `ctx.modes.switch('explore')` at
the exit next to the plane calls. See [input](input.md) for the maps.

## Through the API

1. Create the project from the 3D starter, then the floor, pit, platforms,
   pipes and camera with [`createEntity`](../reference/ops-detail.md#op-createEntity)
   and [`editBlocks`](../reference/ops-detail.md#op-editBlocks) (the values
   above).
2. Publish the script ([the script guide](scripts.md#through-the-api)) and
   attach it with [`setBehaviorProperties`](../reference/ops-detail.md#op-setBehaviorProperties)
   `{"entityId": "<its object>", "behaviorId": "pipe-switch", "values": {"side_camera": "<side camera>", "depth": 0}}`.
3. Play and drive it with `tl_input_exercise` (hold `move` to the left) and
   watch `tl_game_observe`: once `camera.live` names the side camera,
   `player.z` stays 0 whatever `move` asks; past the exit `camera.live` is
   the follow camera again and pushing `move` up moves `player.z`.

The engine's own run of this level, played with real keys in a browser at
the display's 60 Hz cap on both renderers, is `node tools/perf/run.mjs
pipe` (the frames round each switch, the plane held, free after).

## Which to use

Lock with `setPlane` when part of a level changes how it plays and the
player should not notice a seam: a pipe, a door into a side-on room, a
cutaway. Use a scene's **default plane** (Window → Scene settings) when a
whole scene is side-on from its start: its bodies are locked as they load,
with no script.

## Pitfalls

- **Lock what moves with the player.** A body left free can drift out of
  the plane (a crate pushed along Z); static ground does not need the lock,
  but its depth must reach the plane.
- **The lock snaps.** Put the entry where the player is already near the
  plane's depth: a long snap reads as a jump.
- **Freeing does not move it.** A freed character stays where it is, free
  in all three axes; turn it with `ctx.character.turn` if the 3D part needs
  another heading.
- **Locks last until changed**, the object leaves the game or the run
  restarts.
- **`{x, y}` queries follow the lock.** A script on a locked object casts
  `ctx.physics.raycast({x, y}, …)` on its plane; pass `[x, y, z]` for a
  world point.

Related: [cameras](cameras.md), [game modes](game-modes.md),
[input](input.md), [scripts](scripts.md).
