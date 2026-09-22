# Packet 30 — raw snapshot → expected action frame table

Generated from `fixtures/m2/input/raw-sequences.json` (SHA-256 index in
`fixtures/m2/input/index.json`). Every row is re-derived independently by
`fixtures/m2/input/tools/check-input-fixtures.mjs` and replayed by
`packages/input/src/mapping.test.ts`.

## S1-keyboard-digital

A/D and arrow digital controls; holding both cancels to zero (no summation).

| step | keyboard L/R/J | latch | gamepad (mapping, axis0, b0/b14/b15) | → moveX | → jump | next (down, awaitingRelease) |
|---|---|---|---|---|---|---|
| 12 | 1/0/0 | 0 | none | -1 | none | False, False |
| 13 | 1/1/0 | 0 | none | 0 | none | False, False |
| 14 | 0/1/0 | 0 | none | 1 | none | False, False |
| 15 | 0/0/0 | 0 | none | 0 | none | False, False |

## S2-dead-zone-boundary

Radial dead zone 0.2 including the exact boundary; linear rescaling above it.

| step | keyboard L/R/J | latch | gamepad (mapping, axis0, b0/b14/b15) | → moveX | → jump | next (down, awaitingRelease) |
|---|---|---|---|---|---|---|
| 12 | 0/0/0 | 0 | `standard`, 0.2, 0/0/0 | 0 | none | False, False |
| 13 | 0/0/0 | 0 | `standard`, -0.2, 0/0/0 | 0 | none | False, False |
| 14 | 0/0/0 | 0 | `standard`, 0.2001, 0/0/0 | 0.0001 | none | False, False |
| 15 | 0/0/0 | 0 | `standard`, 0.6, 0/0/0 | 0.5 | none | False, False |
| 16 | 0/0/0 | 0 | `standard`, -0.6, 0/0/0 | -0.5 | none | False, False |
| 17 | 0/0/0 | 0 | `standard`, 1, 0/0/0 | 1 | none | False, False |
| 18 | 0/0/0 | 0 | `standard`, -2, 0/0/0 | -1 | none | False, False |

## S3-source-arbitration

Keyboard beats D-pad beats stick; opposing D-pad buttons cancel; a non-standard mapping contributes nothing.

| step | keyboard L/R/J | latch | gamepad (mapping, axis0, b0/b14/b15) | → moveX | → jump | next (down, awaitingRelease) |
|---|---|---|---|---|---|---|
| 12 | 0/0/0 | 0 | `standard`, 0, 0/1/0 | -1 | none | False, False |
| 13 | 0/0/0 | 0 | `standard`, 0.9, 0/0/1 | 1 | none | False, False |
| 14 | 0/1/0 | 0 | `standard`, 0, 0/1/0 | 1 | none | False, False |
| 15 | 0/0/0 | 0 | `standard`, 0, 0/1/1 | 0 | none | False, False |
| 16 | 0/0/0 | 0 | `(non-standard)`, -0.9, 1/0/0 | 0 | none | False, False |
| 17 | 0/0/0 | 0 | none | 0 | none | False, False |

## S4-jump-phase-chain

Press/hold/release chain over consecutive executed steps.

| step | keyboard L/R/J | latch | gamepad (mapping, axis0, b0/b14/b15) | → moveX | → jump | next (down, awaitingRelease) |
|---|---|---|---|---|---|---|
| 12 | 0/0/1 | 0 | none | 0 | pressed | True, False |
| 13 | 0/0/1 | 0 | none | 0 | held | True, False |
| 14 | 0/0/0 | 0 | none | 0 | released | False, False |
| 15 | 0/0/0 | 0 | none | 0 | none | False, False |

## S5-press-latch-and-repeat

A tap shorter than one step latches exactly one edge; repeat events never create a second edge.

| step | keyboard L/R/J | latch | gamepad (mapping, axis0, b0/b14/b15) | → moveX | → jump | next (down, awaitingRelease) |
|---|---|---|---|---|---|---|
| 12 | 0/0/0 | 1 | none | 0 | pressed | True, False |
| 13 | 0/0/0 | 1 | none | 0 | held | True, False |
| 14 | 0/0/0 | 0 | none | 0 | released | False, False |

## S6-suspension-fresh-activation

After a suspension/blur/disconnect the control is awaiting release: a down control is held, never pressed, until observed up once.

initial state: `down=False`, `awaitingRelease=True`

| step | keyboard L/R/J | latch | gamepad (mapping, axis0, b0/b14/b15) | → moveX | → jump | next (down, awaitingRelease) |
|---|---|---|---|---|---|---|
| 12 | 0/0/1 | 0 | none | 0 | held | True, True |
| 13 | 0/0/1 | 0 | none | 0 | held | True, True |
| 14 | 0/0/0 | 0 | none | 0 | none | False, False |
| 15 | 0/0/1 | 0 | none | 0 | pressed | True, False |

## S7-simultaneous-sources

Keyboard and gamepad OR for jump (one edge); keyboard beats the stick for movement.

| step | keyboard L/R/J | latch | gamepad (mapping, axis0, b0/b14/b15) | → moveX | → jump | next (down, awaitingRelease) |
|---|---|---|---|---|---|---|
| 12 | 0/0/1 | 0 | `standard`, 0, 1/0/0 | 0 | pressed | True, False |
| 13 | 0/0/1 | 0 | `standard`, 0, 1/0/0 | 0 | held | True, False |
| 14 | 0/0/0 | 0 | `standard`, 0, 1/0/0 | 0 | held | True, False |
| 15 | 1/0/0 | 0 | `standard`, 0.9, 0/0/0 | -1 | released | False, False |

## S8-absent-and-nonstandard

Absent gamepad and non-standard mapping leave keyboard play intact and the pad contributing nothing.

| step | keyboard L/R/J | latch | gamepad (mapping, axis0, b0/b14/b15) | → moveX | → jump | next (down, awaitingRelease) |
|---|---|---|---|---|---|---|
| 12 | 1/0/0 | 0 | none | -1 | none | False, False |
| 13 | 0/1/0 | 0 | `xinput`, 0.8, 1/0/0 | 1 | none | False, False |
| 14 | 0/0/0 | 0 | none | 0 | none | False, False |

## S9-both-keys-cancel-then-stick

input.md 4.3 item 1 prose ('moveX = 0') vs the accepted packet-17 fixture M3-both-keys-cancel (moveX 0.75): the two digital keys cancel each other (never sum) and the stick then applies. Pinned here as the implemented reading; recorded as contract-change request C30-2.

| step | keyboard L/R/J | latch | gamepad (mapping, axis0, b0/b14/b15) | → moveX | → jump | next (down, awaitingRelease) |
|---|---|---|---|---|---|---|
| 12 | 1/1/0 | 0 | `standard`, 0.8, 0/0/0 | 0.75 | none | False, False |
| 13 | 1/1/0 | 0 | `standard`, -0.8, 0/0/0 | -0.75 | none | False, False |
| 14 | 1/1/0 | 0 | `(non-standard)`, 0.8, 1/0/0 | 0 | none | False, False |

