# Scenario 07 — Crash after the atomic replacement

Pins: workspace.md §5.5 (G1/G2; crash-point table rows 2–4); commands.md
§7.2 (replay when the record is durable), §6.3 (identical retry),
§5.1 (`duplicated`).

## Phase 1 — the crash (narrative; `disk-before` is the resulting disk)

The same in-flight A7 as scenario 06, but the process is killed **after
the `rename` (and the directory flush)** — the durability point has been
reached; only the acknowledgement was lost. On disk:

- `scenes/main.json` = the **new** rev-7 envelope (==
  `envelope/valid/demo-0001-rev7.json`, record R7 for `req-1…07` included);
- no temp file; the ownership record still names dead pid 4242.

## Phase 2 — restart and retry (`messages.json`)

New backend starts; operator takes over the stale ownership (fixture 09);
the rev-7 envelope loads.

1. `queryProject` → `ok`, `revision: 7` (the write is durable — G2 process-
   crash guarantee), `history { 0, 0 }`.
2. `in`: the client retries A7 byte-identically (`expectedRevision: 6` —
   stale). `out`: the **recorded result replayed**: `revision: 7`,
   `createdId: "box-0004"`, `duplicated: true`, the original `change`
   (createEntity box-0004).

## Expected observations

- No double-apply: 6 entities, revision stays 7, `disk-after` is
  byte-identical to `disk-before` (replay performs no write).
- The single-file envelope is what makes this clean: the record is durable
  *with* the state it describes (workspace.md §4.1). There is no window in
  which the revision advanced but the record was missing.
- **Power-loss variant (documented, not materialized):** if the crash were
  a power loss *after the rename but before a durable directory flush* on a
  device with a volatile write cache, the disk could roll back to rev 6 —
  in which case the retry falls into scenario 06's fresh-execution
  behavior instead. Both outcomes are safe (at-most-once, no silent
  loss); the guarantee split is workspace.md §5.5 (G1 vs G2) and
  commands.md §7.3.