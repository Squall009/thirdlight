# Scenario 06 — Crash before the atomic replacement

Pins: workspace.md §5.1 (write procedure), §5.4 (temp cleanup on open),
§5.5 (G1 integrity; crash-point table row 1), §6.4 (reclaim of a dead
owner); commands.md §7.2 (re-execution when no record exists), §7.3
(retry re-executes fresh), §8.1 (deterministic ID scan).

## Phase 1 — the crash (narrative; `disk-before` is the resulting disk)

Backend 4242 (owner per `disk-before/.thirdlight/ownership.json`) applies
A7 = `createEntity box` (`requestId req-1…07`, `expectedRevision 6`) in
memory. A scene edit of a v4 project writes one file — the scene file — so
the durability write is the single-file `W` procedure (no journal): the
new rev-7 scene file is written and fsynced to the temp file
`scenes/.scene-main.json.tmp-4242-7`, whose content is **exactly**
`envelope/valid/demo-0001-rev7/scenes/scene-main.json`. A7's
acknowledgement has not been sent. The process is killed **before the
`rename`** (row 1 of the crash-point table).

On disk after the crash:

- `scenes/scene-main.json` = the old rev-6 scene file (mainline T6, 6
  records); `project.json` and `content.json` untouched;
- `scenes/.scene-main.json.tmp-4242-7` = the new rev-7 scene file
  (leftover);
- the ownership record still names dead pid 4242 (this fixture carries no
  claim file; the reclaim below claims the next epoch).

## Phase 2 — restart and retry (`messages.json`)

Backend C (`tb-cccc…`, pid 4300) starts. Pid 4242 is gone, so the first
access reclaims the project automatically (lockEpoch 0 → 1). On open, the
stale temp is deleted (§5.4) and the rev-6 project loads.

1. `queryProject` → `ok`, `revision: 6`, `history { 0, 0 }` (fresh process:
   the in-memory history did not survive — commands.md §9.2),
   `workspace.writePaused: false`, the v4 `scenes` / `startScenes` blocks.
2. `in`: the client retries A7 **byte-identically** (the ack was lost with
   the crash). `out`: success — `revision: 7`, `createdId: "box-0004"`,
   `duplicated: false`, `history { undoDepth: 1, redoDepth: 0 }`,
   `sceneId: "scene-main"`. No record existed (the rename never happened),
   so the command **re-executes fresh**; the ID scan is deterministic
   against the (unchanged) current state, so the created ID is the one the
   crashed attempt would have produced.

## Expected observations

- No torn file was ever possible: `scene-main.json` held the complete rev-6
  document; only the temp carried the new bytes (G1).
- `disk-after`: the scene file holds the mainline T7 state (same scene as
  `envelope/valid/demo-0001-rev7`) with 7 records, the last one R7 for
  `req-1…07` at `appliedRevision 7` — its recorded `history` is (1, 0), the
  fresh process's depths; **no temp file remains**; the ownership record is
  backend C's (`lockEpoch 1`).
- The logical mutation A7 was applied **exactly once** (at-most-once, G1).
  Had the crash landed after the rename instead, the retry would replay the
  recorded result — scenario 07.

## Differences from the v1 corpus

- The v1 fixture pinned the retry's ack and record with the mainline depths
  (7, 0), which a fresh process cannot produce; it was never replayed by a
  test. The v4 fixture pins (1, 0) and is replayed by
  `packages/workspace/tests/scenarios.test.ts`.
- Replaying this scenario on v4 found two product gaps, fixed in the same
  change: leftover temps of v4 files (`.scene-main.json.tmp-*`,
  `.content.json.tmp-*`, journal temps) were neither cleaned at open nor
  counted by the startup scan (only the v1 `.main.json.tmp-*` were), and the
  reclaim of a dead owner (§6.4) loaded only v1–v3 envelopes, so a v4
  project whose owner crashed stayed `stale_ownership`.
- Real process termination at the same crash point is exercised by
  `tests/crash-recovery.test.ts` (on the same v4 project).
