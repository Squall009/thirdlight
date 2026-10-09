# Your first project

You make a project from the **Starter** template: a small scene with a
ground, a few boxes, a character you can walk with, a spawn point, a camera
and two lights. It has no game rules; you add those yourself.

## In the editor

1. Open the editor URL. With no project open you see the **Projects** page.
2. Under **New project**, fill in:
   - **Project id**: `my-first-game` (lower-case letters, digits, `-` and `_`;
     it never changes).
   - **Name**: `My first game`.
   - **Folder on the server**: leave it empty. The project then lives in
     the data folder (`~/thirdlight/projects/my-first-game`). Give a folder
     to keep the project inside your game's own git repository instead (see
     [Projects and scenes](../concepts/projects-and-scenes.md)).
   - **Template**: **Starter**. (*Empty scene* gives you just a camera and
     lights.)
3. Press **Create and open**. The editor opens on the new project.

## What you see

- The **menu bar**: File, Edit, GameObject, Component, Gizmos, Window, Help.
- The **toolbar**: **◂ my-first-game** (back to the Projects page), the
  move, rotate and scale tools (W, E, R), **snap**, **light** (the scene's
  own lights or a fixed editor light), **▶ play** and **play from…**.
- The **Hierarchy** on the left. The scene **Main** is a header marked
  ACTIVE (new objects go there) and START (the game starts with it). Below
  it are the starter's objects: Main camera, Ground, Step, Platform, Crate,
  Player, Spawn, Key light, Ambient fill and Pillar. A **K** beside an
  object means *Keep loaded*: the camera and the player survive scene
  changes (see [Game flow](../concepts/game-flow.md)).
- The **Scene** view in the centre, with a **Game** tab beside it.
- The **Inspector** on the right. It shows the selected object.
- The bottom dock with three tabs: **Project** (the project's files: the
  Character and Pillar models), **Console** (logs of a running game) and
  **Problems**.
- The **status bar**: the connection, the save state, the project revision
  and the renderer the Scene view uses.

## Make a change

1. Click **Crate** in the Hierarchy. The Inspector shows its flags and
   tags, then its Transform, Box, Materials and Collider sections.
2. In **Transform → Position**, change the second box (Y) from `0.5` to
   `1.5` and press Enter. The crate moves up, and the status bar shows
   `save: saved` and the next revision.
3. Press **Ctrl+Z** (Edit → Undo). The crate goes back. The undo is a
   change too, so the revision goes up again.

Every change is saved at once; there is no Save command. Each change is one
step of undo.

## Through the API

Everything above has an API form. With the token in `$TOKEN` and the
backend on its default port:

```sh
# The templates this engine has.
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8501/api/v1/templates

# Create the project from the Starter template.
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"projectId": "my-first-game", "name": "My first game", "template": "starter"}' \
  http://127.0.0.1:8501/api/v1/admin/projects
```

The answer is `{"ok": true, "created": true, "revision": 0}`.

For a project inside your game's own folder, use the project tool instead.
It talks to the running backend:

```sh
node tools/project.mjs create ~/projects/my-game --id my-game --name "My game" --template starter
```

This writes `thirdlight.json` (the marker, with the engine version the
project is pinned to) and `thirdlight/` (the project files) into the
folder. See [Deployment: Projects in a game's own folder](../../deployment.md#projects-in-a-games-own-folder).

A change is a **command**. Read the current revision first, then send the
command with it:

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"op": "queryProject", "projectId": "my-first-game", "args": {}}' \
  http://127.0.0.1:8501/api/v1/projects/my-first-game/commands
# → {"ok": true, "revision": 0, ...}

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"op": "setTransform", "projectId": "my-first-game", "expectedRevision": 0,
       "requestId": "req-0123456789abcdef0123456789abcdef",
       "args": {"entityId": "box-0004", "transform": {"position": [-2, 1.5, 0]}}}' \
  http://127.0.0.1:8501/api/v1/projects/my-first-game/commands
# → {"ok": true, "op": "setTransform", "revision": 1, ...}
```

Use the revision `queryProject` answered as `expectedRevision` (0 only on a
project nobody has changed yet). `box-0004` is the Crate's id. `requestId` is `req-` and 32 lower-case hex
digits, new for each command. A command sent with an old revision is
refused with `revision_conflict` and changes nothing; read the revision
again and resend. `{"op": "undo", …}` undoes the last change. The request
and every op are listed in the reference: [the request](../reference/ops.md#op-request),
[setTransform](../reference/ops-detail.md#op-setTransform).

AI tools send the same commands through MCP (`tl_command`). See
[The editor and the API](../concepts/editor-and-api.md).

Next: [your first Play](first-play.md).
