# Scenario 08 — Unexpected external modification

Pins: workspace.md §5.2 (pre-write hash check), §7 (detection, snapshot,
pause, accept/discard), §7.4 (recovery artifacts are evidence, not backup);
commands.md §5.4 (`external_change_unresolved`), §5.6 (queries served from
last-known-good while paused), §9.2 (history boundary on accept).

## Precondition (disk-before)

Backend (owner pid 5000 per `disk-before/.thirdlight/ownership.json`)
runs `demo-0001` at mainline T7 (revision 7; `main.json` ==
`envelope/valid/demo-0001-rev7.json`). The backend's in-memory last-known-
good is exactly these bytes (`lastWrittenHash`).

## The external edit (narrative; `disk-external/` is the resulting disk)

A bypassing writer (a human editing by hand, *without* releasing the
workspace — the unsupported path) replaces `scenes/main.json` with
`disk-external/scenes/main.json`: box-0001's material color changed to
`#ff8800`, **everything else byte-for-byte identical** (revision stays 7,
retry block copied). The backend is not told.

## Messages (`messages.json`)

1. `in`: a fresh mutation — `setTransform box-0004 { position: [0,1,0] }`
   (`requestId req-6…01`, `expectedRevision 7`).
   `out`: `error` `external_change_unresolved` (`cls: "unavailable"`) with
   `pendingChange { externalHash, externalValid: true, externalErrorCount:
   0 }`. The pre-write hash check (workspace.md §5.2) found foreign bytes
   **before** any temp file was written; the foreign bytes were parsed
   (valid envelope) and snapshotted; writes are paused. No state change.
2. `in`: `queryProject`. `out`: served from the **last known good**
   in-memory state — `revision: 7` (the original color),
   `workspace.writePaused: true`, `pauseReason: "external_change"`,
   full `pendingChange`. The in-memory projection is never silently
   discarded (charter §6).
3. `in`: operator `acceptExternalState`. `out`: `{ ok: true, revision: 7,
   historyReset: true, retryCleared: true }`. The external scene becomes
   authoritative: the envelope is re-serialized canonically with
   `retry.records: []` (new retry boundary) and re-written atomically;
   history cleared (new boundary).
4. `in`: the same logical edit **re-issued with a fresh requestId**
   (`req-6…02`, `expectedRevision 7`). `out`: success — `revision: 8`,
   `change` setTransform box-0004 → `[0,1,0]`.

## Expected observations

- `disk-after`:
  - `scenes/main.json` = rev-8 envelope: the accepted color `#ff8800`,
    box-0004 position `[0,1,0]`, and **exactly one retry record** (the
    block was cleared on accept, then repopulated by the post-accept
    command at `appliedRevision 8`);
  - `.thirdlight/recovery/scene-20260917T101500Z-<sha8>.json` = the
    external writer's bytes **byte-identical** (verified) — evidence and
    repair aid, never a backup; the snapshot filename embeds the first 8
    hex of `pendingChange.externalHash`;
  - the ownership record is unchanged (we remained the owner throughout).
- **Discard branch (documented, not materialized as a second disk state):**
  had the operator chosen `discardExternalState`, the last-known-good
  rev-7 bytes would have been re-written atomically instead, history
  cleared, and the external bytes would survive only in the recovery
  snapshot. Both resolutions clear history (charter §6: an external file
  replacement establishes a new history boundary; M1 performs no
  reconciliation).
- Had the external bytes been **invalid** (corrupt/mid-edit), step 1 would
  still fire, `pendingChange.externalValid` would be `false` with the
  error objects, and only `discardExternalState` would be possible
  (`acceptExternalState` refused with `external_change_invalid`).
- Detection latency: the check runs at the next envelope write; a watcher
  could only make it earlier — it is not a correctness dependency
  (workspace.md §7.1). This scenario's trigger is exactly the normative
  one.