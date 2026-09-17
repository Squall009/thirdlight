# Scenario 09 — Second-backend ownership rejection

Pins: workspace.md §6 (ownership record, open-time evaluation, conservative
liveness, claim primitive, explicit takeover, no automatic takeover), §6.4
(stale-owner recovery), §11 (workspace ops/error codes); commands.md §5.4
(`project_unavailable` with `reason` + `holder`).

## Precondition (disk-before)

`demo-0001` at mainline T7 (`main.json` == `envelope/valid/demo-0001-rev7.json`).
Backend A (`backendId tb-aaaa…`, pid 5000) owns the project
(`disk-before/.thirdlight/ownership.json`, `lockEpoch 0`). Backend B
(`backendId tb-bbbb…`, pid 5150) is a **second backend process** that tries
to use the project (on-demand open).

## Messages (`messages.json`)

**Phase 1 — A is alive:**

1. `in`: B issues `queryProject`. `out`: `error`
   `project_unavailable` (`cls: "unavailable"`) with
   `reason: "ownership_conflict"` and the full `holder` record (A's
   backendId, pid 5000, openedAt, lockEpoch 0, state owned). B's open is
   refused; **no takeover is attempted** — automatic takeover is
   forbidden (workspace.md §6.4). A continues to serve the project
   unaffected.

**Phase 2 — A has crashed (same ownership file; pid 5000 now dead):**

2. `in`: B retries `queryProject`. `out`: `project_unavailable` with
   `reason: "stale_ownership"` (same `holder`). The dead owner's record is
   **never claimed automatically**: the open fails and names the recovery
   path.
3. `in`: operator `takeoverWorkspace`. `out`: `{ ok: true, lockEpoch: 1,
   backendId: tb-bbbb…, pid: 5150 }`. The takeover re-reads the record
   (byte-identical to the one evaluated stale), re-evaluates liveness
   (still dead), and claims via the rename-and-verify primitive
   (workspace.md §6.3) — a concurrent taker would lose the verify and
   abort.
4. `in`: B retries `queryProject`. `out`: `ok`, `revision: 7` — B now owns
   and serves the project.

## Expected observations

- `disk-after/.thirdlight/ownership.json` = B's record (`lockEpoch 1`,
  `openedAt` later, state owned); `disk-after/scenes/main.json` is
  **byte-identical** to `disk-before` — ownership operations never touch
  authoring data (workspace.md §6.5).
- `lockEpoch` is a monotonic audit counter in the record itself: the
  0 → 1 transition is visible in the artifact.
- Liveness evaluation is conservative (workspace.md §6.2): any `/proc`
  ambiguity resolves to "live" (reject), because a false "dead" costs
  split-brain risk while a false "live" costs one operator check.
- **Residual split-brain (honest bound, workspace.md §6.4):** the
  pathological case where a backend believed it owned before a record was
  stolen from under it degrades safely — its next envelope write's pre-
  write check finds foreign bytes, pauses, and snapshots them (the
  scenario-08 mechanism). No silent corruption of the envelope.