# Saves

**Goal:** save the game to a slot and continue from it later: the values
your scripts keep, plus the game's own record of where the play stands.
Everything a save can hold and where it is stored:
[Saves](../features/saves.md); the fields:
[Project saves](../reference/content-blocks-save-schema.md#content-saveSchema);
the calls: [`ctx.saves`](../reference/script-api.md#ctx-saves) and
[`ctx.save`](../reference/script-api.md#ctx-save).

A project's **save schema** says how many slots there are, the version of
the save document, and which engine state every save includes. Your
scripts write the **save document** (any JSON, up to 1 MiB per slot) and
ask for a save or a load. Saves live in the player's browser, per project;
Play keeps its own apart from exported games.

## In the editor

1. **File → Project Settings… → Saves**: **Version** 1, **Slots** 3, and
   under **Included in every save** tick **Script storage** (the
   `ctx.save` values) and whatever else your game changes at run time
   (block cells, spawned objects, objects' health…). Leave **Where the play
   stands** off: your game restores its scenes and player itself (below).
   **Apply**.
2. A script on a kept object saves and loads:
   ```ts
   import type { BehaviorContext } from '@thirdlight/runtime';

   export default {
     instantiate() {
       return {};
     },
     step(_state: object, ctx: BehaviorContext): void {
       if (ctx.ui.event('save')) {
         // The game's own record of where the play stands.
         ctx.saves.write({ level: 'level-1' });
         ctx.saves.save(1, { title: 'Slot 1', location: 'Level 1' });
       }
       if (ctx.ui.event('continue')) ctx.saves.load(1);
       for (const result of ctx.saves.results()) {
         if (!result.ok) ctx.log('warn', `save ${result.op} failed: ${result.code ?? ''}`);
         if (result.op === 'load' && result.ok) {
           const doc = ctx.saves.read() as { level?: string } | null;
           if (doc?.level !== undefined && ctx.scenes.status(doc.level) === 'unloaded') ctx.scenes.load(doc.level);
           ctx.lifecycle.respawn();
           ctx.modes.switch('play');
         }
       }
     },
   };
   ```
   Buttons on your pause or title document raise the events `save` and
   `continue` (see [UI documents](ui-documents.md)). The game shell's own
   **Save** and **Load** screens and its `save`/`load`/`continue` engine
   actions do the same without a script.
3. **▶ play**, save, stop, then **Play from… → Save slot** 1: the game
   starts from that slot. **Saves → Clear Play save** forgets Play's
   saves.

## Through the API

1. [`setSaveSchema`](../reference/ops-detail.md#op-setSaveSchema):
   `{"schema": {"version": 1, "slots": 3, "sections": ["storage", "components"], "legacyWorld": false}}`.
2. Publish and attach the script ([the script guide](scripts.md#through-the-api)).
3. Play, raise the save (test input or a UI event), then observe:
   `saves.slots` lists slot 1 with its title, location, play time and size.
4. Start a new Play from the slot: `tl_play_start {saveSlot: "1"}` (over
   HTTP `{"options": {"saveSlot": "1"}}`). `start.applied` says
   `project save slot 1`; the `ctx.save` values are back and your load
   handler has loaded the level. `tl_play_start` also takes a whole save
   document (`save: {format: "thirdlight.save", version, doc, …}`) for a
   test that needs a given state.

## Which to use

Set the schema in the editor; write the document and the load handling in
a script. Test saves through the API: a Play started from a slot or a
document reaches the state you want to check in one call.

## Pitfalls

- **A load arrives a step later.** `ctx.saves.load` asks storage; the
  outcome is in `ctx.saves.results()` once storage answers. Restore your
  scenes and player there, not right after the call.
- **Without *Where the play stands*, a load moves nothing.** That is the
  point: your game decides where the player goes. A schema with neither
  `world` nor `legacyWorld: false` keeps the old always-on world and writes
  one Problems line (see the
  [migration notes](../features/migration.md#the-always-on-world-in-saves-deprecated)).
- **Kept objects are yours to fill in.** A save never destroys or replaces
  them; restore their state from your document.
- **`saveSlot` is text** in `tl_play_start` (`"1"`, not `1`).
- **A refused write is a result**, not an error: `{ok: false, code}` with
  `storage_full`, `storage_unavailable` or `storage_failed`. Tell the
  player.
- **Change the document's shape → raise the version** and register a
  migration (`ctx.saves.migration(name, fn)`, listed in the schema), or
  older saves will not load.
- **`ctx.save` survives a scene reload**; reset what a new game must not
  keep.

Related: [title, new game, restart and scene changes](game-flow.md).
