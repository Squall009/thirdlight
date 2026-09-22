# Thirdlight — M3 gameplay/respawn/camera fixtures (packet 40)

**PROPOSED — not accepted.** These fixtures accompany packet 40's proposals:

- [`docs/planning/m3-contracts/gameplay.md`](../../../docs/planning/m3-contracts/gameplay.md)
  — the new proposed contract home (run state machine, M3 phase order, zone
  service, reset transaction, `GameView`, camera math, limits and errors);
- [`docs/planning/m3-contracts/diffs/runtime.md`](../../../docs/planning/m3-contracts/diffs/runtime.md)
  — the section-level `OLD → NEW` edits to `docs/contracts/runtime.md`;
- packet 39's [`model.md`](../../../docs/planning/m3-contracts/model.md) §23
  (PROPOSED v3 `gameZone`/`playerSpawn`/`cameraFollow`/`content.game` data this
  contract consumes and does not redefine).

Nothing in `docs/contracts/` is changed and nothing here is implemented. Gate K
records accept/reject per diff; a separate docs-only promotion applies accepted
rows before packet 44. Packets 49–51 implement the behaviour.

Machine-readable index: [`index.json`](index.json). Repeatable checks:
[`verification.md`](verification.md),
[`tools/check-fixtures.mjs`](tools/check-fixtures.mjs).

The camera fixtures live in [`../camera/`](../camera/) and are verified by this
same checker.

## Layout

```text
fixtures/m3/gameplay/
  index.json                     fixture index: contract constants, digests, byte lengths
  verification.md                repeatable commands, negative control, closed-form arithmetic
  tools/check-fixtures.mjs       self-contained plain-Node checker (no dependency)
  run/
    states.json                  run state machine, queue semantics, command validity
    respawn-timing.json          the exact 30-step bounded delay and its step timeline
    events-bound.json            40 deaths → MAX_GAME_EVENTS retention/eviction counters
    failure-phases.json          last-committed-state assertion for all 15 failure phases
    held-jump.json               M3 effective-frame overrides (anti-phantom-jump)
    segment-source.json          lastMotionSegment ≠ (state.prev, state.curr)
    game-view.json               view identity and staleness rules
  zones/
    sweep.json                   12 swept-capsule cases (enter/exit/tangent/fast/drop/jump)
    precedence.json              8 same-step precedence and stable-ID tie cases
    spawn.json                   7 reset-destination validation cases
    run-semantics.json           teleport non-sweep, goal-from-respawn, single activation
  errors/codes.json              the five new error codes + accepted reason additions
fixtures/m3/camera/
  index.json
  README.md / verification.md
  follow.json  bounds.json  snap.json  resize.json  owner.json
```

## Conventions

- JSON fixtures are canonical: UTF-8, LF, 2-space indent, one trailing newline,
  no BOM, no trailing whitespace. The checker verifies the bytes and the
  two-space indent form as well as every declared `sha256`/`bytes`.
- **The run fixtures are a replay of the state machine from recorded step
  segments**, not physics: each step op supplies the committed motion segment
  `from → to` that the runtime's transform phase produced
  (`gameplay.md` §3.2). The checker re-derives the zone decision, the run state,
  the counters and every event object (including the event `id`).
- Step indices in the run fixtures start at the post-pre-roll index (`firstStep`
  12 for most cases, 99 for the delay-arithmetic case); the boundary
  (queue consumption + scheduled reset) runs **before** each step, exactly as
  `gameplay.md` §3.2 item 0 requires.
- Viewport token values: the strings `"NaN"`, `"Infinity"` and `"-Infinity"`
  stand for the non-finite numbers JSON cannot carry (camera `resize.json`).
- Fixture-only values are marked in `notes`: `zone-0008` (a hazard placed after
  the checkpoint spawn so a case can die after activating the checkpoint) and
  the goal-from-respawn case's safe-spawn centre.
- **Nothing here is browser, physics or visual evidence.** Packet 49–51 own the
  real Rapier course, the runtime traces and the browser framing records.
