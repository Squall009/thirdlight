# Working with an AI agent

An AI coding agent (Claude Code, or any client that speaks MCP) can build
and play-test your game through the same commands as the editor. It learns
the engine from the engine itself, never from reading Thirdlight's source:

- **The MCP tools** answer *what exists*. `tl_docs` serves this manual and
  the generated reference of the running build: every op, component, script
  call, graph node and limit.
- **The Thirdlight skill** answers *how to work*: the workflow, where game
  rules go, game flow, play-testing, performance habits and common traps.
  It lists no ops or fields; it points into `tl_docs`.

## Set up a game folder for an agent

1. Start the backend and register the MCP server once for your user, as in
   [Deployment: MCP](../../deployment.md#mcp-coding-harness).
2. Create the project in the game's folder with the project tool (or from
   the editor's project picker with **Folder on the server**):
   ```sh
   node tools/project.mjs create ~/projects/my-game --id my-game --name "My game" --template starter
   ```
   Besides `thirdlight.json` and `thirdlight/`, this installs the skill into
   `~/projects/my-game/.claude/skills/thirdlight/`. Commit it with the rest.
   For a folder that already holds a project, run
   `node tools/project.mjs register ~/projects/my-game` and then
   `node tools/project.mjs skill ~/projects/my-game`.
3. Start the agent in the folder (`cd ~/projects/my-game && claude`). The
   MCP server finds the project from the folder's `thirdlight.json`; Claude
   Code finds the skill in `.claude/skills/` and loads it when the work is
   about the game. The server's instructions send the agent to `tl_docs`
   first.

To check the connection, ask the agent to call `tl_inspect` with
`target="engine"`: it answers the engine version, the build and the manual
it serves.

## Keep the skill current

The skill is stamped with the engine version it was written for (its
`metadata` in `SKILL.md`), and the install keeps a record of every file it
wrote (`.thirdlight-skill.json` beside them).

- `node tools/project.mjs check <folder>` warns when the folder has no
  skill, when the installed copy differs from the one this engine ships, when
  its stamp differs from the engine version the project is pinned to, and
  when someone edited it.
- `node tools/project.mjs skill <folder>` installs or updates it. It never
  overwrites a copy you edited: it names the edited files and changes
  nothing. `--force` replaces it with the engine's. Keep your own notes for
  agents in the game's `CLAUDE.md` instead, so updates stay automatic.
- After an engine upgrade: rebuild and restart the backend (so `tl_docs`
  matches it), `check --repin` once you have checked the game, and `skill`.

A project in the data root has no game folder: set `THIRDLIGHT_PROJECT_ID`
for the MCP server and run `project.mjs skill` on the folder the agent works
in.

Next: [concepts](../index.md#concepts), or the
[play-testing guide](../guides/playtesting.md) an agent follows to test.
