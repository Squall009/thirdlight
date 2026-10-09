# Existing projects keep their look

When the engine improves a default, a game you already made should not
change on its own. Thirdlight follows one rule for this:

- **A setting your project does not set keeps the old look and behaviour.**
  When a new engine changes what a setting's default is, an existing
  project that never wrote the setting goes on as before.
- **New projects write the new defaults explicitly.** A project made today
  (empty or from a template) gets the current values written into its
  settings, so it starts with them and keeps them.

An example: ambient occlusion. A project that does not set
`ambient_occlusion` draws GTAO, the only kind there was before the setting
existed. A new project is made with `ambient_occlusion: 1` (SSAO, the
faster kind) written into its settings. A new project from the Starter has
these settings in its `content.json`:

```json
"settings": { "ambient_occlusion": 1, "block_chunk_storage": 1 }
```

To take an improvement in an older project, set the setting yourself
(**File → Project Settings…**). Each setting's tooltip and the
[settings in the reference](../reference/content-blocks-save-schema.md#content-settings)
say what an unset value means.

## Opening an older project

A project made with an older engine is upgraded the first time it is
opened, and written back in the current format. Ids do not change, so
references, recorded commands and replays stay valid. Problems says once
what the upgrade changed. In a game's own folder, commit what the upgrade
wrote (and commit or back up before opening). The details for each format
version are in [Migration notes](../features/migration.md#migration-notes).
