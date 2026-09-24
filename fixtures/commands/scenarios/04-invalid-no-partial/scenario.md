# Scenario 04 — Invalid transactions leave no partial changes

Pins: commands.md §6.1 (no partial changes — every failure path returns
before any durable write), §5.2 (error shape with project-model `details`),
§5.4 (codes/classes), §6.5 (`no_change`).

## Precondition (disk-before)

`demo-0001` at T5 (revision 5, 5 records; `box-0001` — entity index 3,
after the camera and the two starter lights — has `position [1.5, 0.25,
0]`, identity rotation).

## Messages (messages.json) — four rejected commands, all at `expectedRevision 5`

1. `setTransform box-0001 { rotation: [0,0,0,0] }` (zero quaternion)
   → `error` `quaternion_invalid` (`cls: "validation"`). The error carries
   `detailDocument: "result-scene"` and `details` = the project-model
   error object for the *resulting* scene
   (`/entities/3/components/transform/rotation`, with the model's own
   message/expected/hint text), `detailCount: 1`.
2. `deleteEntity { entityId: "ghost-0001" }`
   → `error` `entity_not_found` (`cls: "validation"`, `entityId`).
3. `createEntity { kind: "box", parentId: "ghost-0001" }`
   → `error` `reference_missing` (`cls: "validation"`, `found`,
   `expected`) — preconditions are checked against the current scene
   before anything else.
4. `setTransform box-0001 { position: [1.5, 0.25, 0] }` — exactly the
   current value → `error` `no_change` (`cls: "validation"`). A project
   with a content catalog (every v4 project) compares the resulting scene
   **and** content with the current ones; equal ⇒ rejected before any
   record, with the message "the resulting scene and content are
   byte-identical to the current state" (no hint).

## Expected observations

- **`disk-after` is byte-identical to `disk-before`** (all three project
  files). Revision still 5, still 5 records — none of the four requests is
  recorded (only successful mutations are).
- The durability write (pipeline step 7) is reached only after steps 2–6
  all pass; these requests fail at steps 4–6, so the on-disk state cannot
  have changed. The pure replay (`packages/commands/src/
  scenario-04-failures.test.ts`) also pins that the in-memory scene and
  history are bit-for-bit unchanged after every rejection.
- Each failure is structured and actionable (§5.5): fix the args and
  re-issue (fresh requestId; the failed requestIds are unrecorded).

## Differences from the v1 corpus

- The v1 fixture pinned the M1 `no_change` wording ("request would not
  change the scene", with a hint); a v4 project always has content, so the
  content-aware wording applies.
- The v1 fixture's quaternion hint predated the project-model's wording and
  needed a tolerant compare; the v4 fixture carries the model's text and
  is compared strictly.
