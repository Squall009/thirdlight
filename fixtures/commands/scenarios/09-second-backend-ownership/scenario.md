# Scenario 09 — Second-backend ownership rejection

Pins: workspace.md §6 (ownership record, open-time evaluation, conservative
liveness, claim primitive, the claim file), §6.4 (reclaim of a dead owner),
§11 (workspace ops/error codes); commands.md §5.4 (`project_unavailable`
with `reason` + `holder`).

## Precondition (disk-before)

`demo-0001` at mainline T7 (`disk-before` == `envelope/valid/demo-0001-rev7`).
Backend A (`backendId tb-aaaa…`, pid 5000) owns the project
(`disk-before/.thirdlight/ownership.json`, `lockEpoch 0`, and its exclusive
claim file `claim-0`). Backend B (`backendId tb-bbbb…`, pid 5150) is a
**second backend process** that tries to use the project (on-demand open).

## Messages (`messages.json`)

**Phase 1 — A is alive:**

1. `in`: B issues `queryProject`. `out`: `error` `project_unavailable`
   (`cls: "unavailable"`) with `reason: "ownership_conflict"` and the full
   `holder` record (A's backendId, pid 5000, openedAt, lockEpoch 0, state
   owned). B's open is refused; a live owner is never taken over. A
   continues to serve the project unaffected.

**Phase 2 — A has died (same ownership file; pid 5000 now gone):**

2. `in`: B retries `queryProject`. `out`: `ok`, `revision: 7` (the v4
   `scenes` / `startScenes` blocks included). The previous owner is
   **proven dead** by the same-host liveness check, so B reclaims the
   project automatically: it re-reads the record (byte-identical to the one
   evaluated stale), re-evaluates liveness (still dead), and claims via the
   rename-and-verify primitive at `lockEpoch 1` — then loads and serves the
   project. A live or unknown holder still conflicts (message 1).

## Expected observations

- `disk-after/.thirdlight/ownership.json` = B's record (`lockEpoch 1`,
  `openedAt` later, state owned); the project files in `disk-after` are
  **byte-identical** to `disk-before` — ownership operations never touch
  authoring data (workspace.md §6.5).
- `lockEpoch` is a monotonic audit counter in the record itself: the
  0 → 1 transition is visible in the artifact.
- Liveness evaluation is conservative (workspace.md §6.2): any `/proc`
  ambiguity resolves to "live" (reject), because a false "dead" costs
  split-brain risk while a false "live" costs one operator check.
- **Residual split-brain (honest bound, workspace.md §6.4):** a backend
  that believed it owned before its record was taken degrades safely — its
  next write's pre-write check finds foreign bytes, pauses, and snapshots
  them (the scenario-08 mechanism). No silent corruption of the project.

## Differences from the v1 corpus

- The v1 narrative still described the pre-2026-09-18 flow (a
  `stale_ownership` error, then an explicit `takeoverWorkspace`); its
  `messages.json` already pinned the automatic reclaim. The narrative now
  matches the messages.
- On v4 the reclaim failed (`stale_ownership`: the §6.4 load step read only
  v1–v3 envelopes); fixed in the same change — this scenario is its test.
