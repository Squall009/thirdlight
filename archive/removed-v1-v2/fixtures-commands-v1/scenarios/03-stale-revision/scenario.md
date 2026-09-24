# Scenario 03 — Stale revision (and the recovery re-issue)

Pins: commands.md §6.1 step 4 (revision check precedes argument
validation), §6.4 (recovery path), §7.1 (failed commands are never
recorded), §5.4 (`revision_conflict` fields).

## Precondition (disk-before)

`demo-0001` at T5 (revision 5; `disk-before/scenes/main.json` ==
`envelope/valid/demo-0001-rev5.json`).

## Messages (messages.json)

1. `in`: `setTransform box-0001 { position: [0.75, 0, 0] }` with
   `expectedRevision: 4` (the client's view is one revision stale) and
   `requestId req-3…01`.
2. `out`: `error` `revision_conflict` (`cls: "conflict"`) with
   `expectedRevision: 4`, `currentRevision: 5`. No validation of the args
   is attempted — the request is stale, full stop.
3. `in`: the recovery re-issue — the **same logical intent** (same args)
   with a **fresh** `requestId req-3…02` and `expectedRevision: 5`.
4. `out`: success: `revision: 6`, `change` = setTransform with
   `previous.position [1.5, 0.25, 0]` → `next.position [0.75, 0, 0]`,
   `changedFields: ["position"]`, `history { undoDepth: 1, redoDepth: 0 }`.

## Expected observations

- Message 1 changed nothing and recorded nothing (a failed command leaves
  no record; its requestId may even be safely reused later, but clients
  must generate fresh IDs).
- `disk-after`: the branch-specific rev-6 envelope (6 records: R1–R5 plus
  the new record for `req-3…02` at `appliedRevision 6`). Note this state
  intentionally diverges from the mainline T6 (which instead created
  box-0003) — scenarios are self-contained.
- The re-issue proves the conflict response is self-sufficient: it carried
  `currentRevision`, so the client did not even need a query to recover.