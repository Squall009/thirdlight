# The editor and the API

The backend owns your project. Nothing writes the project files except the
backend, and the backend changes a project only through **commands**. The
editor, the HTTP API, AI tools over MCP and build scripts all send the same
commands. There is no second way in.

## Commands

A command names an **op** (`createEntity`, `setComponent`, `publishBehavior`,
…), the project, the revision it expects and a request id:

```json
{ "op": "setTransform", "projectId": "my-first-game", "expectedRevision": 4,
  "requestId": "req-<32 hex digits>", "args": { "entityId": "box-0004", "transform": { "position": [0, 1, 0] } } }
```

- The backend checks the command completely before it changes anything. A
  refused command changes nothing and says why.
- A command that succeeds advances the revision by exactly one.
- A command with an old revision is refused (`revision_conflict`): someone
  else changed the project first. Read it again and resend. Nothing is
  overwritten by accident.
- A command resent with the same request id is not applied twice: the
  answer says `duplicated: true`.
- Undo and redo are commands too (`undo`, `redo`).

Every op and its arguments are in the reference: [command ops](../reference/ops.md#op-index).

## The same ops everywhere

| You use | It sends commands through |
|---|---|
| The editor | Every panel, menu and handle. |
| HTTP | `POST /api/v1/projects/<id>/commands`, with the token. |
| AI tools | MCP's `tl_command` (and `tl_content_query` to read). |
| Build scripts | Any of the above. |

The editor sends every op except two that only tools need:
`createEntities` (many objects in one command; the editor makes them one at
a time) and `importResources` (sent by the backend's own file check). An
engine test fails when a new op has no way to send it from the editor.

Changes from any source show in an open editor at once, and you can undo
them there.

## Which to use

- Use the **editor** to look, place, tune and play. Anything visual or
  felt (a light's colour, a jump's height) is decided by looking at it.
- Use the **API** to make many things at once, to generate content from
  data, or to let an AI tool build and test. A build script that sends
  commands is repeatable and reviewable.

Both make the same project; mix them freely.

## What never changes the project

- **Play** runs a snapshot of the project. A running game never writes
  back to the project.
- **Scripts** change the running game only (spawning, moving, loading
  scenes), never the project files.
- **Exports** read the project and write a separate folder.

How to connect an AI tool: [Deployment: MCP](../../deployment.md#mcp-coding-harness).
