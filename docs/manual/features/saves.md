# Saves

Project save slots, what a save keeps, the save schema and its settings
document, where saves are stored and what a refused write says. Step by
step: [the saves guide](../guides/saves.md); the fields:
[Project saves](../reference/content-blocks-save-schema.md#content-saveSchema).

## Saves

Saves are the project's own (below): the game shell's Save and Load screens
and scripts write and read project save slots in the player's browser. The
engine keeps no autosave, slots or checkpoint saves of its own. Play keeps its saves apart from exported games (and
each project apart from the others); **Saves → Clear Play save** forgets
Play's (MCP: `tl_game_control` `clearSave`).

**Where the play stands (`world`).** A save can also carry the loaded
scenes, the active spawn, the scene-list entry and the character's position,
velocity and facing (`world`, save format version 2). Loading such a save
unloads the scenes it did not have (never a kept object: those stay), loads
the ones it had, and puts the character back where it stood (from rest, its
velocity given back at its next move). Because that decides where a game
stands after Continue, `world` is an **opt-in section**: list it in the
schema's sections (**Where the play stands**), or set `legacyWorld: false`
(the Saves tab's *restore scenes in the game*) and restore scenes and the
player from the game's own document (`ctx.scenes.load`, `character_place`
with `facing`). A schema that does neither keeps the always-on world of
before, with one Problems line per Play (see [Migration notes](migration.md#the-always-on-world-in-saves-deprecated)); a new save
schema starts with `legacyWorld: false`. A game that does not keep `world`
writes none and loads any save — one with a world too — without a scene
change. A version 1 save (no `world`) still loads; a save whose world names
a scene the game does not have is refused.

### Project save documents

Any game can declare its own save format in
Project Settings → **Saves** (MCP: `setSaveSchema {schema | null}`):

- **Version** of the save document, and **migrations**: for each older
  version the name of a script function that upgrades a document by one
  version. A script registers it with
  `ctx.saves.migration('v1to2', (doc, fromVersion) => newDoc)`; a save of
  version 1 loaded by a version-3 game runs `v1to2` then `v2to3`. A save
  newer than the game, or one whose migration no script registered, is not
  loaded (nothing changes; the outcome says why).
- **Slots**: 1–99 (engine limit 99).
- **Included state** (opt-in): *block cells* (the cells scripts changed,
  `ctx.grid`), *material values* (`ctx.materials`), *spawned objects*
  (prefab copies with their placement and ids; their scripts start fresh),
  *script storage* (`ctx.save`), *environment* (the preset blend,
  `ctx.environment`), *dialogue* (its variables and the lines seen),
  *objects' state* (`components`: health, collectibles, patrols and
  hitboxes as the game changed them), *where the play stands* (`world`,
  above).
  A section the schema includes but a save lacks is reset to the run's start
  on load (a missing world leaves the scenes as they are).
- **Slot picture**: size and format (default 256 × 144 JPEG; at most
  512 px a side and 64 KiB).
- **Settings document**: fields (bool, number, string, choice) with
  defaults, which the game's own settings screen writes with
  `ctx.saves.setSetting(key, value)` and reads with `ctx.saves.setting(key)`.
  A field may drive an engine setting — music, sound or menu volume (a 0–1
  number) or quality (a choice of the project's quality level ids: low/medium/high unless it lists its own) — which applies at once.
  It is kept in the player's browser (localStorage, per project) and the
  game starts with it.

Scripts build the document themselves: `ctx.saves.write(doc)` / `read()`
(any JSON, at most **1 MiB per slot** with its sections), `save(slot, {title,
chapter, location, thumbnail, meta})`, `load(slot)`, `delete(slot)`, `slots()` (title,
chapter, location, play time, when, version, size, picture, `meta`), `ready()`,
`results()` (the outcomes, one step after storage answers), `playSeconds()`.
A save is taken at the end of the step it was asked for; a loaded save is
restored at the end of the step storage's answer arrives, so every host (the
page, the simulation worker, a replay) restores it at the same step —
storage's answers are part of the recorded input. `meta` is the game's own
small record for a slot card (a party leader, a portrait id, a difficulty):
names (letters, digits, _; up to 32 characters, so a load screen binds them
as `$item.meta.<name>`) to texts, as many as fit in **4 KiB** for the whole
record as JSON (UTF-8 bytes; `SAVE_LIMITS.metaBytes`, read for every slot
when the slots are listed); a record over it is refused (`save()` answers
false). `slots()` gives `{}` for a slot saved without one. In a 3D project the save's `world.character` also keeps the
character's facing (degrees), and a load turns it back (older saves without
it leave it as it is). A UI `image` widget shows a slot's picture with
`saveSlot` (a slot number, or a binding to one such as `$item.slot` on a
load screen's list) in place of `image`; nothing while the slot has none, a
new picture as soon as the slot is saved again.

Slots live in the browser's IndexedDB for the game's site (localStorage's
~5 MB per site could not hold 99 slots of 1 MiB): database
`thirdlight-saves`, keys `<ns>:slot:<n>:meta`, `:body` and `:thumb`, where
`<ns>` is `thirdlight:<projectId>` in an export and
`thirdlight-play:<projectId>` in Play, so Play, exported games and each
project keep separate ones; the settings document is in localStorage under
`<ns>:project-settings`. An export needs no backend. A slot's metadata,
body and picture are written (and deleted) in **one transaction**: a save
the browser refuses or a page closed while it writes leaves the slot's
previous save whole, never a slot the checksum calls damaged.

A refused write is a clear result for the game's own message: the outcome
in `results()` is `{ok: false, code, reason}`, `reason` the browser's text
and `code` one of `storage_full` (the disk or the site's quota is full),
`storage_unavailable` (the page has no IndexedDB — storage turned off, some
private windows — so nothing can be saved; reads find no slots) or
`storage_failed` (anything else, such as a write cut off). A settings
document localStorage refuses is reported the same way, as a result
`{op: 'settings', slot: 0, ok: false, code, reason}`; the value still applies
for the session (the game shell's own volumes and the player's key
bindings are logged instead). At the first save the host asks the browser to
keep the site's data under disk pressure (`navigator.storage.persist()`;
some browsers ask the player, others decide silently); `ctx.saves.storage()`
gives `{persisted, usage, quota}` (bytes from `navigator.storage.estimate()`,
refreshed after each save; null where the browser does not say).

`tl_game_observe` (and an export's `__thirdlightObserve()`) report `saves
{slotCount, storage (indexeddb, memory or unavailable), persisted, usage,
quota, persistAsked, slots (the first 32 used, with their picture's type and
size), settings}`, and Play diagnostics `saves {storage, persistAsked,
persisted, usage, quota}`; the page exposes a slot's picture as
`__thirdlightSaveThumbnail(slot)` (a data URL).
`tl_play_start` also takes a project save document (`{format:
"thirdlight.save", version, playSeconds?, doc, sections?}`, loaded at the
first step and migrated) or `saveSlot` 1–99 (a project slot of the Play page).
