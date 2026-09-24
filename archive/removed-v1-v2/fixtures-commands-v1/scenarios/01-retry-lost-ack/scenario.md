# Scenario 01 — Retry after lost acknowledgement

Pins: commands.md §6.1 (dedup precedes the revision check), §6.3 (replay),
§7.1 (recorded result replay, `duplicated`), §7.2 (restart-safe records).
Workspace: the record and the state live in ONE atomic envelope
(workspace.md §4.1).

## Precondition (disk-before)

`demo-0001` at mainline state T5 (`disk-before/scenes/main.json` ==
`envelope/valid/demo-0001-rev5.json`): revision 5, entities
`[cam-main, box-0001, box-0002, group-0001]`, retry records R1–R5.

Background (already happened, not a message): the mcp client submitted
A5 = `setTransform box-0002 { rotation: 90° yaw about Y }` with
`expectedRevision 4`, `requestId req-1…05`. The backend applied it: the
envelope advanced to revision 5 **and** record R5 was written in the same
atomic replacement. The success acknowledgement was lost in transit.

## Messages (messages.json)

1. `in`: the client retries **byte-identically** the original A5 request
   (same `expectedRevision 4`, same `requestId`).
2. `out`: the recorded result R5, returned with `duplicated: true`,
   `revision: 5`, the full `change` (setTransform, previous/next,
   `changedFields: ["rotation"]`).

## Expected observations

- The retry is answered at pipeline step 2 (dedup), **before** the
  revision check: the retried `expectedRevision` (4) is stale — current is
  5 — but that is irrelevant for an identical retry. No revision is
  consumed, no history entry is added, no write happens.
- `disk-after` is **byte-identical** to `disk-before` (verified: the
  `main.json` hashes match).
- The client now continues at revision 5 with fresh requestIds; its
  projection already contains the A5 change (the replayed `change` is the
  original change).

## Notes

- The same request retried after a backend **restart** behaves identically
  (the record was durable with the state — workspace.md §4.1; scenario 07
  exercises the restart variant).
- If the record had been evicted (retention 128, commands.md §7.1), the
  retry would instead fail `revision_conflict` — safe, never a
  double-apply. Not exercised here (only 5 records exist).