# Thirdlight manual

Thirdlight is a game editor and engine that runs in your browser. A server
holds your projects; the editor, scripts and AI tools all edit them through
it. A finished game is exported as a folder of static files that runs on any
web server, without Thirdlight.

This manual has four parts:

- **Getting started** takes you from an install to an exported game.
- **Concepts** explains the ideas the rest of the manual builds on. Read it
  once before you build something larger than the starter scene.
- **Guides** walk through one task each, in the editor and through the API.
- **Reference** lists what the engine offers: every component, field,
  command, script call, graph node and limit. It is generated from the
  engine's source, so it always matches the engine it came with.

Running the server itself (a service, a reverse proxy, the access token,
backups, the MCP connection) is described in
[Deployment](../deployment.md).

## Getting started

1. [Install and start Thirdlight](getting-started/install.md)
2. [Your first project](getting-started/first-project.md)
3. [Your first Play](getting-started/first-play.md)
4. [Your first export](getting-started/first-export.md)
5. [Working with an AI agent](getting-started/agents.md)

## Concepts

- [Projects and scenes](concepts/projects-and-scenes.md)
- [Objects and components](concepts/objects-and-components.md)
- [Prefabs](concepts/prefabs.md)
- [Assets](concepts/assets.md)
- [Scripts and the step model](concepts/scripts-and-the-step-model.md)
- [The game shell](concepts/game-shell.md)
- [Game flow belongs to your game](concepts/game-flow.md)
- [2D and 3D](concepts/2d-and-3d.md)
- [Existing projects keep their look](concepts/existing-projects.md)
- [The editor and the API](concepts/editor-and-api.md)
- [Streaming and budgets](concepts/streaming-and-budgets.md)

## Guides

Each guide gives the editor path and the API path, and says which one to
use and why.

- [Which tool for which job](guides/which-tool.md)
- Building worlds
  - [Build a level with block layers](guides/block-layers.md)
  - [Build terrain: sculpting, rule materials, scatter, splines and blocks on terrain](guides/terrain.md)
  - [Dress a scene with instance sets](guides/instance-sets.md)
  - [Generate rooms and buildings](guides/generated-architecture.md)
  - [Lighting and baking](guides/lighting.md)
  - [Sky, fog and environment presets](guides/environment.md)
- Objects and look
  - [Make and spawn a prefab](guides/prefabs.md)
  - [Material graphs](guides/material-graphs.md)
  - [Trim sheets](guides/trim-sheets.md)
  - [Effects](guides/effects.md)
  - [The animator](guides/animator.md)
  - [Cameras](guides/cameras.md)
- Game logic
  - [Write a script and a shared library](guides/scripts.md)
  - [Visual scripts](guides/visual-scripts.md)
  - [Title, new game, restart and scene changes](guides/game-flow.md)
  - [Game modes](guides/game-modes.md)
  - [Saves](guides/saves.md)
  - [Input and rebinding](guides/input.md)
  - [Local co-op players](guides/co-op.md)
- Presentation
  - [A HUD and menus with UI documents](guides/ui-documents.md)
  - [Dialogue](guides/dialogue.md)
  - [A cutscene with a timeline](guides/timelines.md)
  - [Audio](guides/audio.md)
- Shipping
  - [Play-test with the headless runner](guides/playtesting.md)
  - [Measure and budget performance](guides/performance.md)
  - [Export](guides/export.md)
  - [Limits](guides/limits.md)

## Features

[Features](features/index.md) holds the full description of each feature
area, one page per area: everything a feature does, its settings and its
edge cases.

## Reference

[The engine reference](reference/index.md): objects and components, content
documents, command ops, the script API, node graphs, limits and defaults.
