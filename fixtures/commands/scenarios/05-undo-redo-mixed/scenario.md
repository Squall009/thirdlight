# Scenario 05 — Undo/redo with mixed human/agent edits

Pins: commands.md §9 (history model: cursor, invalidation, reset
boundaries), §9.3 (single shared stack across origins; `appliedOf` /
`originOfApplied`), §8.4 (inverse/forward re-application, recorded IDs —
no re-scan), §5.1/§5.3 (change data for undo/redo), §7.1 (undo/redo are
recorded mutations).

## Precondition (disk-before)

A new `demo-0001` at revision 0 (`disk-before` ==
`envelope/valid/demo-0001-rev0`: `cam-main`, `light-0001`, `light-0002`).
Origins: `browser-demo` (browser) and `pi-harness` (mcp).

## Messages (messages.json) — 9 steps; depth = (undoDepth, redoDepth)

| # | op | origin | effect | revision | depth after |
|---|----|--------|--------|----------|-------------|
| 1 | createEntity box "Ground" → box-0001 | browser | create | 1 | (1,0) |
| 2 | setTransform box-0001 pos [0,0,-0.5] | mcp | transform | 2 | (2,0) |
| 3 | createEntity box "Crate" → box-0002 | browser | create | 3 | (3,0) |
| 4 | deleteEntity box-0002 | mcp | subtree delete | 4 | (4,0) |
| 5 | undo | browser | **restores box-0002** (inverse of the mcp delete) | 5 | (3,1) |
| 6 | undo | browser | deletes box-0002 (inverse of the browser create) | 6 | (2,2) |
| 7 | redo | mcp | re-creates box-0002 (recorded entity, original ID, end of array) | 7 | (3,1) |
| 8 | setTransform box-0001 pos [0,0.25,-0.5] | mcp | fresh edit — **invalidates redo** | 8 | (4,0) |
| 9 | undo | browser | box-0001 back to pos [0,0,-0.5] (inverse of the mcp edit) | 9 | (3,1) |

Every acknowledgement ends with `sceneId: "scene-main"` (undo and redo
route to the scene the history entry edited).

## Expected observations

- **Undo crosses origin boundaries**: step 5 undoes an *mcp* command. The
  shared single stack is normative (commands.md §9.3): undo always targets
  the last applied command regardless of who issued it; the result carries
  `appliedOf: req-2…04` and `originOfApplied: { kind: "mcp", … }` so the
  client can show "AI edit undone". Step 9 mirrors this (browser undoes an
  mcp edit, `appliedOf: req-2…08`).
- **Restore semantics**: step 5's `change` is
  `restoreSubtree { rootId, entities: [full box-0002 value] }` — the
  client projection can re-add the entity from the change alone.
  Step 6's inverse is a `deleteEntity` change (LIFO ⇒ the created entity's
  subtree is itself).
- **Redo uses recorded data, not re-scan**: step 7 re-inserts the *recorded*
  entity value with its original ID `box-0002` at the end of the array
  (its original position by the LIFO argument).
- **Redo invalidation**: step 8 truncates the redo tail (`redoDepth` 0);
  step 9 leaves `redoDepth 1` (the mcp edit is undoable once more).
- **History is in-memory**: it is not in the project files; a restart
  would reset both depths to 0 (not exercised here). The scene file at
  `disk-after` (rev 9) contains **9 records** — undo/redo are full
  mutations with their own `requestId`/digest/record (a lost-ack retry of
  an undo replays like any other command). `content.json` is unchanged.
- Final scene: `[cam-main, light-0001, light-0002, box-0001 (pos
  [0,0,-0.5]), box-0002]`, revision 9 — also reproduced by an independent
  forward/inverse replay in the fixture tool's self-check
  (`verification.md` §1).
