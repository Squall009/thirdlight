# Streaming and budgets

A project may hold as many assets, resources and scenes as a full game
needs; there is no count limit. The game loads what it needs while it runs
and frees what it no longer uses, inside memory budgets. In one sentence
each:

- **Scenes.** A game reads only its start scenes' files before its first
  picture; other scenes are read when they load (and likely next scenes
  ahead of time) — see [projects and scenes](projects-and-scenes.md).
- **Assets.** Each model, texture, sound and font is held by what uses it
  and freed when the last user goes; scripts load and release extra ones by
  name with [`ctx.assets`](../reference/script-api.md#ctx-assets) — see
  [assets](assets.md).
- **Textures.** Large compressed (KTX2) textures stream their detail inside
  the **texture budget** (`texture_budget_mb`, 512 MiB unless you set it),
  dropping what is least needed first.
- **World streaming.** A terrain or block layer with **Streaming** rings
  keeps only the tiles and chunks around the camera and the players loaded,
  inside the **streaming budget** (`streaming_budget_mb`, 768 MiB unless
  you set it).
- **Quality levels** let the player trade picture for speed (render scale,
  shadows, effects); with **dynamic resolution** on (`dynamic_resolution`),
  the game lowers its render scale by itself while frames run long.

What stays fixed are **engine limits** that protect the running game: the
size of one file, how many objects one scene holds, how many lights shine
at once and similar. They are listed, with their values, in
[limits and defaults](../reference/limits.md#limits-index). Both budgets
are project settings: see
[the settings in the reference](../reference/content-blocks-script-libraries.md#content-settings).

Guides: [measure and budget performance](../guides/performance.md),
[limits](../guides/limits.md).
