# Owned diff rows — `runtime.md` (packet 64, packet 67)

Proposal: `../delivery.md` §5 (D-63-9). Gate Q. **PROPOSED — not
accepted.**

## C64-7 — NO contract text change (adjudication record)

The packet-63 D-63-9 gap ("the v3 play snapshot contract cannot carry
the `game` block the M3 host requires") was re-read against the accepted
`runtime.md` text, and **the accepted contract already mandates the
`game` field** on v3 snapshot documents:

- §2 field table: "`game` | **v3 snapshots only, required.** A
  deep-frozen copy of the validated `content.game` block (`project-model`
  §23.4) or `null`. Present iff `scene.schemaVersion === 3`; absent for
  v1/v2 (an unknown field on a v1/v2 snapshot is still
  `snapshot_invalid`, `reason: "shape"`)".
- §2 rule: "The game block travels with the snapshot (M3) … It is
  therefore carried **inside** the snapshot (never re-read from disk,
  never looked up through the runtime's host) so that one snapshot
  remains the runtime's only input".

The runtime's own `RuntimeSnapshot` type already carries
`game?: GameConfig | null`, and its snapshot validator already rejects a
v1/v2 document that carries `game` (the accepted rule, implemented).
**D-63-9 is therefore an implementation gap in three layers, not a
contract gap:**

1. **backend** (`packages/backend/src/backend.ts`, the retained
   `play.started` snapshot construction): builds the 4-key document
   although `state.content.game` is available in the same read.
   Repair: include `game` (the validated value or `null`) in the v3
   snapshot document; v1/v2 stay 4-key. (Packet 71 or 70 — owner choice
   at Gate Q; the ledger tracks it under the snapshot-document row.)
2. **protocol type** (`packages/protocol/src/ws-events.ts`
   `RuntimeSnapshotDoc`): gains `game?: … | null` — present iff
   `scene.schemaVersion === 3`.
3. **bridge validator** (`packages/protocol/src/bridge.ts`
   `tl.snapshot` case): the snapshot key allowlist admits `game` **iff**
   `snapshot.scene.schemaVersion === 3` (rejected otherwise, mirroring
   the accepted shape rule at the transport gate); `game` is a plain
   object or `null` — **deep shape validation is the runtime's**
   (the accepted §2 "the producer is not trusted" rule); the bridge does
   the shape gate only, exactly as it does for `scene`. The `tl.snapshot`
   size bound (≤ 1 MiB) is unchanged: the `game` block is ≤ 16 384 B
   (the manifest `game` row bound), so a v3 snapshot still fits.

The preview's snapshot check (M4 `delivery.md` §2.8 step 5) gains the
`gameDigest` verification (the accepted manifest digest rule, M3
delivery §2.4), so the transported `game` value is digest-bound
end-to-end against the manifest.

**No other `runtime.md` change.** §6 (the frame ordering the M4 model
wiring builds on), §8 (diagnostics) and §15 are untouched.

## C67-3 — NO `runtime.md` change (adjudication record — packet 67)

Proposal: `../reliability.md` §3, §10. Gate Q.

- The runtime §8 structured diagnostics (`getDiagnostics()` — the 32-entry
  error ring, the bounded counters, the fail-stop fields) are the per-play
  source that the reliability.md §3 health report aggregates. The report
  never adds a runtime state, field or code; it reads the accepted §8 shape
  (via the backend's play records) and clips it into the bounded report
  lists.
- No runtime constant changes: the ring bound (32) and the error-entry
  shape (≤ 256 chars, log-safe, no secrets/paths) are re-used verbatim by
  the report's `errors` list — the §11.5 additive rows of C67-2 re-state
  existing values, not new ones.
- The fail-stop lifecycle (§13/§14) and the M3 run diagnostics (§15) are
  untouched; a failed play is reported through the accepted `failed` /
  `failedModuleId`/`failedPhase`/`failedStepIndex` fields, which the health
  report surfaces under `play` as a counter (`activePlaySessions`) + the
  session-layer error ring — no new runtime diagnostic surface.

**No other `runtime.md` change (packet 67).**