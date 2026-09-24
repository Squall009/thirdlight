# Scenario 07 — Crash after the atomic replacement

Pins: workspace.md §5.5 (G1/G2; crash-point table rows 2–4), §6.4
(reclaim of a dead owner); commands.md §7.2 (replay when the record is
durable), §6.3 (identical retry), §5.1 (`duplicated`).

## Phase 1 — the crash (narrative; `disk-before` is the resulting disk)

The same in-flight A7 as scenario 06, but the process is killed **after
the `rename` of the scene file (and the directory flush)** — the
durability point has been reached; only the acknowledgement was lost. On
disk:

- `scenes/scene-main.json` = the **new** rev-7 scene file
  (== `envelope/valid/demo-0001-rev7/scenes/scene-main.json`, record R7 for
  `req-1…07` included);
- no temp file; the ownership record still names dead pid 4242.

## Phase 2 — restart and retry (`messages.json`)

Backend C (`tb-cccc…`, pid 4300) starts and reclaims the dead owner's
project automatically (lockEpoch 1); the rev-7 project loads.

1. `queryProject` → `ok`, `revision: 7` (the write is durable — G2 process-
   crash guarantee), `history { 0, 0 }`.
2. `in`: the client retries A7 byte-identically (`expectedRevision: 6` —
   stale). `out`: the **recorded result replayed**: `revision: 7`,
   `createdId: "box-0004"`, `duplicated: true`, the original `change`
   (createEntity box-0004), the original depths (7, 0), and the acked
   `sceneId: "scene-main"` (record version 2 stores it; see scenario 01).

## Expected observations

- No double-apply: 8 entities, revision stays 7; the three project files
  in `disk-after` are byte-identical to `disk-before` (replay performs no
  write). Only the ownership record changes (backend C, `lockEpoch 1`).
- The record is durable *with* the state it describes (the scene file is
  replaced in one atomic rename). There is no window in which the revision
  advanced but the record was missing. A multi-file transaction (not used
  by this corpus: a command that changes the scene index writes
  `content.json` and a scene file) gets the same property from the redo
  journal `.thirdlight/journal.json`, its commit point, rolled forward at
  the next open (pinned by `packages/workspace/tests/storage-v4.test.ts`).
- **Power-loss variant (documented, not materialized):** if the crash were
  a power loss *after the rename but before a durable directory flush* on a
  device with a volatile write cache, the disk could roll back to rev 6 —
  in which case the retry falls into scenario 06's fresh-execution
  behavior instead. Both outcomes are safe (at-most-once, no silent loss).

## Differences from the v1 corpus

- The v1 `disk-after` kept the crashed owner's record, although the
  narrative had a new backend take the project over; the v4 fixture pins
  the new owner's record and is replayed by
  `packages/workspace/tests/scenarios.test.ts` (the v1 fixture was not).
