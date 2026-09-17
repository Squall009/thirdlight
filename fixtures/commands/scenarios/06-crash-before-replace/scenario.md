# Scenario 06 — Crash before the atomic replacement

Pins: workspace.md §5.1 (write procedure), §5.4 (temp cleanup on open),
§5.5 (G1 integrity; crash-point table row 1); commands.md §7.2
(re-execution when no record exists), §7.3 (retry re-executes fresh),
§8.1 (deterministic ID scan).

## Phase 1 — the crash (narrative; `disk-before` is the resulting disk)

Backend A (pid 4242, owner per `disk-before/.thirdlight/ownership.json`)
applies A7 = `createEntity box` (`requestId req-1…07`,
`expectedRevision 6`) in memory, then runs the durability write
(workspace.md §5.1): the new rev-7 envelope is written and fsynced to the
temp file `scenes/.main.json.tmp-4242-7` — whose content is **exactly**
`envelope/valid/demo-0001-rev7.json` (verified byte-identical). A7's
acknowledgement has not been sent. The process is killed **before the
`rename`** (the crash window of row 1 in the crash-point table).

On disk after the crash:

- `scenes/main.json` = the old rev-6 envelope (mainline T6, 6 records);
- `scenes/.main.json.tmp-4242-7` = the new rev-7 envelope (leftover);
- the ownership record still names dead pid 4242.

## Phase 2 — restart and retry (`messages.json`)

A new backend process starts. (The operator performs the explicit
`takeoverWorkspace` for the stale owner — the mechanics are fixture 09.)
On open, the stale temp is deleted (workspace.md §5.4) and the rev-6
envelope loads.

1. `queryProject` → `ok`, `revision: 6`, `history { 0, 0 }` (fresh process:
   the in-memory history did not survive — commands.md §9.2),
   `workspace.writePaused: false`.
2. `in`: the client retries A7 **byte-identically** (the ack was lost with
   the crash). `out`: success — `revision: 7`, `createdId: "box-0004"`,
   `duplicated: false`. No record existed (the rename never happened), so
   the command **re-executes fresh** (commands.md §7.2/§7.3); the ID scan
  is deterministic against the (unchanged) current state, so the created
   ID is the one the crashed attempt would have produced.

## Expected observations

- No torn file was ever possible: `main.json` held the complete rev-6
  document; only the temp carried the new bytes (G1, workspace.md §5.5).
- `disk-after`: `scenes/main.json` == `envelope/valid/demo-0001-rev7.json`
  (7 records, last one R7 for `req-1…07` at `appliedRevision 7`); **no
  temp file remains**; the ownership record is the new owner's
  (`lockEpoch 1`).
- The logical mutation A7 was applied **exactly once** (at-most-once,
  G1). If the crash had landed after the rename instead, the retry would
  replay the recorded result — scenario 07.