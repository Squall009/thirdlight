# Cameras

**Goal:** a camera that follows the player, a wide overview shot of the
level, and a script that blends between them when the player presses
**interact**. Every rig and setting is in the
[virtual camera reference](../reference/components-camera.md#component-virtualCamera);
the full description is in [Deployment: Cameras](../../deployment.md#cameras-virtual-cameras)
(it moves to the scenes and cameras feature page).

A camera is a **shot**: an object with a **Virtual camera** component. The
view shows the enabled camera with the highest **priority** (on a tie the
one activated last). When the live camera changes, the view blends from
what is on screen to the new one (**Blend in**: cut, linear or eased over
**Blend time**).

## In the editor

1. **GameObject → Cameras → Camera** makes a camera (or **+ Add component →
   Virtual camera** on any object). Set **Rig** to *Follow / orbit*,
   **Target** to the player, **Target offset** 0, 1, 0, **Distance** 9,
   **Pitch** 10, **Damping** 0.2 and **Priority** 10.
2. A second camera for the overview: **Rig** *Fixed / look-at*, placed high
   and back, **Target** a landmark, **Priority** 0, **Blend in** eased over
   1 s.
3. With a camera selected, the Scene view draws its frustum where its rig
   puts it. **Gameplay → Camera** (Project Settings) lists the cameras and
   the project's lens settings.
4. A script on the follow camera (see [scripts](scripts.md)) raises the
   overview's priority while it should be live:
   ```ts
   import type { BehaviorContext } from '@thirdlight/runtime';

   export const properties = {
     overview: property.entityRef(null, { tooltip: 'The overview camera' }),
   };

   interface State { wide: boolean }

   export default {
     instantiate(): State {
       return { wide: false };
     },
     step(state: State, ctx: BehaviorContext): void {
       if (!ctx.input.pressed('interact')) return;
       state.wide = !state.wide;
       ctx.camera.setPriority(ctx.properties.overview as string, state.wide ? 20 : 0);
     },
   };
   ```
   Pick the overview camera in the script's **Overview** property.
5. **▶ play**, press **E** (interact): the view blends to the overview and
   back on the next press.

## Through the API

1. The follow camera ([`createEntity`](../reference/ops-detail.md#op-createEntity)):
   `{"sceneId": "scene-main", "kind": "group", "name": "Follow camera", "components": {"virtualCamera": {"rig": "follow", "target": "<player>", "targetOffset": [0, 1, 0], "distance": 9, "pitch": 10, "damping": 0.2, "priority": 10}}}`.
2. The overview: `{"sceneId": "scene-main", "kind": "group", "name": "Overview camera", "transform": {"position": [8, 9, 22]}, "components": {"virtualCamera": {"rig": "fixed", "target": "<landmark>", "priority": 0, "blend": "eased", "blendTime": 1}}}`.
3. Publish the script above ([the script guide](scripts.md#through-the-api))
   and attach it with [`setBehaviorProperties`](../reference/ops-detail.md#op-setBehaviorProperties)
   `{"entityId": "<follow camera>", "behaviorId": "camswitch", "values": {"overview": "<overview camera>"}}`.
4. Play and observe: `camera.live` names the follow camera. Send one
   `interact` press as test input; after the blend `camera.live` names the
   overview, `camera.blend` is null, and a screenshot shows the wide shot.

Other script calls ([`ctx.camera`](../reference/script-api.md#ctx-camera)):
`activate(id, {blend, time})`, `deactivate`, `setTarget`, `set(id,
{distance, yaw, pitch, fovY, letterbox, …})`, `shake(amplitude, seconds)`,
`worldToScreen` and `screenToRay`.

## Which to use

Frame shots in the editor: the frustum and the Game view show what the
player will see. Switch cameras from scripts (or timelines) by priority or
`activate`, so the camera follows the game's state. Use the API to set up
cameras for many levels from data, and to check the live camera in a
play-test.

## Pitfalls

- **No live camera** at the start: Play and the export still start, from a
  default pose, and write a Problems line. Keep one enabled camera in a
  start scene (the starter's is at priority −1000, below any you add).
- **Priority decides, not order.** A camera you add at priority 0 does not
  take over from one at 10; raise it or `activate` it.
- **An object reference property starts as `null`** in code
  (`property.entityRef(null)`), not `""`.
- **Rig fields apply per rig.** Distance means nothing to a fixed camera;
  the Inspector shows only the fields the chosen rig uses.
- **Collision pulls a follow camera in front of walls in 3D projects
  only.**
- **Camera changes apply at the end of the step**, the same in a replay and
  in the export.

Related: [scripts](scripts.md), [the animator](animator.md).
