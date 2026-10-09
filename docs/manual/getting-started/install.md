# Install and start Thirdlight

Thirdlight is a Node program. One backend serves the editor, the play
preview and the HTTP API for all your projects. AI tools reach the same
backend through a small MCP server.

## What you need

- Node 22.15 or later in 22, and git.
- A desktop browser with WebGPU or WebGL 2. The engine's own tests run in
  Chromium; other browsers are untested.

The full list, and how to run the backend as a service or behind a reverse
proxy, is in [Deployment: Requirements](../../deployment.md#requirements).

## Install

Clone the repository and install its dependencies, including the
development ones (the start script builds the editor with them):

```sh
git clone https://github.com/Squall009/thirdlight.git
cd thirdlight
NODE_ENV=development npm ci --include=dev
```

`NODE_ENV=development` matters when your shell sets
`NODE_ENV=production`: npm then skips the development dependencies and the
build fails.

## Start

```sh
npm start
```

The first start builds `dist/` (when it is missing), creates the data folder `~/thirdlight`
(projects in `projects/`, exports in `exports/`) and writes the access token
to `~/thirdlight/owner-token`. Then it prints:

```
Thirdlight is running.
  editor:   http://127.0.0.1:8501/#token=<token>
  projects: /home/you/thirdlight/projects
  token:    /home/you/thirdlight/owner-token
  MCP:      THIRDLIGHT_AUTHORING_ORIGIN=... THIRDLIGHT_MCP_TOKEN=<the token> node .../mcp.mjs ...
```

Open the editor URL. When the output is not a terminal (a service, a log
file), the URL has no token; the page then shows an **Access token** field.
Paste the contents of `~/thirdlight/owner-token` and press **Open**. The
browser keeps the token, so next time `http://127.0.0.1:8501/` is enough.

Press Ctrl+C to stop the backend.

Useful options: `--data-root DIR`, `--port N`, `--preview-port N`,
`--host HOST` (to reach the editor from another machine) and `--build`
(rebuild `dist/` after an update). See
[Deployment: Start](../../deployment.md#start) and
[The owner token](../../deployment.md#the-owner-token).

## For AI tools

The MCP line in the output is the command an AI coding tool runs to reach
the same backend. How to register it is in
[Deployment: MCP](../../deployment.md#mcp-coding-harness).

Next: [your first project](first-project.md).
