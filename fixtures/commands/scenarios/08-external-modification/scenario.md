# Scenario 08 — Unexpected external modification

Pins: workspace.md §5.2 (pre-write hash check), §7 (detection, snapshot,
pause, accept/discard), §7.4 (recovery artifacts are evidence, not backup);
commands.md §5.4 (`external_change_unresolved`), §5.6 (queries served from
last-known-good while paused), §9.2 (history boundary on accept).

## Precondition (disk-before)

Backend A (owner pid 5000 per `disk-before/.thirdlight/ownership.json`,
holding `claim-0`) runs `demo-0001` at mainline T7 (revision 7;
`disk-before` == `envelope/valid/demo-0001-rev7`). The backend's in-memory
last-known-good is exactly these bytes (it knows every file's hash).

## The external edit (narrative; `disk-external/` is the resulting disk)

A bypassing writer (a human editing by hand, *without* releasing the
workspace — the unsupported path) replaces `scenes/scene-main.json` with
`disk-external/scenes/scene-main.json`: box-0001's material color changed
to `#ff8800`, **everything else identical** (revision stays 7, retry block
copied). The backend is not told.

## Messages (`messages.json`)

1. `in`: a fresh mutation — `setTransform box-0004 { position: [0,1,0] }`
   (`requestId req-6…01`, `expectedRevision 7`).
   `out`: `error` `external_change_unresolved` (`cls: "unavailable"`) with
   `pendingChange { snapshotState: "ok", externalHash, externalValid: true,
   externalErrorCount: 0 }`. The pre-write check of the file the command
   writes (the scene file) found foreign bytes **before** any temp file was
   written; the project on disk was re-read (valid) and the foreign bytes
   durably snapshotted; writes are paused. No state change.
2. `in`: `queryProject`. `out`: served from the **last known good**
   in-memory state — `revision: 7` (the original color),
   `workspace.writePaused: true`, `pauseReason: "external_change"`,
   full `pendingChange`.
3. `in`: operator `acceptExternalState`. `out`: `{ ok: true, revision: 7,
   historyReset: true, retryCleared: true }`. The files on disk become the
   project: **every** project file is rewritten canonically with its
   records cleared (a new retry boundary) — `content.json` is stamped with
   the project revision (7) — and history is cleared (new boundary).
4. `in`: the same logical edit **re-issued with a fresh requestId**
   (`req-6…02`, `expectedRevision 7`). `out`: success — `revision: 8`,
   `change` setTransform box-0004 → `[0,1,0]`, `sceneId: "scene-main"`.

## Expected observations

- `disk-after`:
  - `scenes/scene-main.json` = rev 8: the accepted color `#ff8800`,
    box-0004 position `[0,1,0]`, and **exactly one retry record** (cleared
    on accept, then the post-accept command at `appliedRevision 8`);
  - `content.json` = revision 7, no records (rewritten by the accept);
  - `.thirdlight/recovery/scene-20260917T101500Z-<sha8>.json` = the
    external writer's bytes **byte-identical** — evidence and repair aid,
    never a backup; the snapshot filename embeds the first 8 hex of
    `pendingChange.externalHash`; exactly one snapshot exists;
  - the ownership record is unchanged (we remained the owner throughout).
- **Discard branch (documented, not materialized as a second disk state):**
  had the operator chosen `discardExternalState`, this backend's
  last-known-good bytes of the changed file would have been re-written
  instead and history cleared; the external bytes survive only in the
  recovery snapshot. A **second** foreign write that appears while the
  change is pending is never overwritten by the discard: the protocol
  re-fires (new snapshot, new pending hash) —
  `packages/workspace/tests/external-change.test.ts`. (Replaying that test
  on v4 found the v4 discard overwriting such a never-snapshotted write;
  fixed in the same change.)
- Had the external bytes been **invalid** (corrupt/mid-edit), step 1 would
  still fire, `pendingChange.externalValid` would be `false` with the
  error objects, and only `discardExternalState` would be possible
  (`acceptExternalState` refused with `external_change_invalid`).
- Detection latency: the check runs at the next write (and at the
  editor's poll); a watcher could only make it earlier — it is not a
  correctness dependency (workspace.md §7.1).
