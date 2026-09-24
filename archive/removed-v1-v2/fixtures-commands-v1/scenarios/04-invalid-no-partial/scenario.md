# Scenario 04 — Invalid transactions leave no partial changes

Pins: commands.md §6.1 (no partial changes — every failure path returns
before any durable write), §5.2 (error shape with project-model `details`),
§5.4 (codes/classes), §6.5 (`no_change`).

## Precondition (disk-before)

`demo-0001` at T5 (revision 5, 5 records; `box-0001` has
`position [1.5, 0.25, 0]`, identity rotation).

## Messages (messages.json) — four rejected commands, all at `expectedRevision 5`

1. `setTransform box-0001 { rotation: [0,0,0,0] }` (zero quaternion)
   → `error` `quaternion_invalid` (`cls: "validation"`). The error carries
   `detailDocument: "result-scene"` and `details` = the project-model
   error objects for the *resulting* scene
   (`/entities/1/components/transform/rotation`), `detailCount: 1`.
2. `deleteEntity { entityId: "ghost-0001" }`
   → `error` `entity_not_found` (`cls: "validation"`, `entityId`).
3. `createEntity { kind: "box", parentId: "ghost-0001" }`
   → `error` `reference_missing` (`cls: "validation"`, `found`,
   `expected`) — preconditions are checked against the current scene
   before anything else.
4. `setTransform box-0001 { position: [1.5, 0.25, 0] }` — exactly the
   current value → `error` `no_change` (`cls: "validation"`). The
   no-change test (commands.md §6.5) masks `revision := 0` and
   byte-compares canonical scenes; equal ⇒ rejected before any record.

## Expected observations

- **`disk-after` is byte-identical to `disk-before`** (verified: the
  `main.json` hashes match). Revision still 5, still 5 records — none of
  the four requests is recorded (only successful mutations are).
- The durable envelope is the only file the editing path may write
  (workspace.md §4.1), and the durability write (pipeline step 7) is
  reached only after steps 2–6 all pass; these requests fail at steps 4–6,
  so the on-disk state cannot have changed. This is the observable meaning
  of "no partial changes" in M1.
- Each failure is structured and actionable (§5.5): fix the args and
  re-issue (fresh requestId; the failed requestIds are unrecorded).