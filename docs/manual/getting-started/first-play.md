# Your first Play

**Play** runs your game inside the editor, isolated from the project: the
game starts from the project as it is at that revision, and nothing the game
does changes the project.

## In the editor

1. Press **▶ play** in the toolbar. The centre switches to the **Game** tab.
   A line above the picture names the run (`play my-first-game@r0`) and the
   renderer (WebGPU, or WebGL 2 where WebGPU is missing).
2. Click the picture so the game gets the keyboard.
3. Walk with **A** and **D** or the arrow keys. Jump with **Space**. A
   gamepad works too (left stick or d-pad, button A to jump).
4. Press **■ stop** to end the run.

These keys are the engine's default input actions (`move`, `jump`, and
more). A project changes them in **File → Project Settings… → Input**.

While Play runs:

- The **Console** tab shows what the game logs, and script errors at their
  source lines.
- The **Problems** tab lists what the start checks found (for example a
  scene with no live camera).
- Changes you make in the editor do not reach the running game. Stop and
  press play again to see them.

**play from…** starts somewhere else: at another scene, with script
variables, or from a save slot.

## Through the API

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:8501/api/v1/projects/my-first-game/play
# → {"ok": true, "playSessionId": "play-…", "snapshotId": "my-first-game@r0", ...}
```

When no editor page is open on the project, the backend opens its own
headless editor and runs the game there. With the `playSessionId`:

```sh
P=http://127.0.0.1:8501/api/v1/projects/my-first-game/play/<playSessionId>
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' $P/observe
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' $P/screenshot
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' $P/stop
```

`observe` answers with the game's state: `state: "running"`, the step, the
player's position, the loaded scenes, the live camera and more.
`screenshot` answers with the picture as a PNG data URL (`dataUrl`).

AI tools do the same with the MCP tools `tl_play_start`,
`tl_game_observe`, `tl_screenshot`, `tl_input_exercise` (press actions step
by step) and `tl_play_stop`.

Next: [your first export](first-export.md).
