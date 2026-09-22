# `fixtures/m2/input` — raw-snapshot → action-frame sequences (packet 30)

Replayable, Node-checkable input fixtures for the packet-30 device binding.
They are the committed evidence that the pure mapping produces **exact**
sampled frames: `@thirdlight/input`'s `mapRawInput` and the fixture checker
re-derive the same values from two independent implementations, and
`packages/input`'s vitest suite replays `raw-sequences.json` step by step.

## Files

- `raw-sequences.json` — nine sequences (38 steps) of
  `{ stepIndex, raw: RawInputSnapshot }` with the expected `ActionFrame` and
  the expected next sampling state. Covered: keyboard digital controls and
  cancellation, the 0.2 dead-zone boundary and linear rescaling, source
  precedence (keyboard → D-pad → stick, no summation), non-standard mapping
  and absent device, the press latch and key-repeat coalescing, the
  press/hold/release phase chain, fresh activation after suspension, and
  simultaneous keyboard/gamepad sources.
- `index.json` — SHA-256 of every committed fixture file (no orphans, no
  dangling entries).
- `tools/check-input-fixtures.mjs` — plain-Node checker; exit 0 = consistent.
  Run it from the repository root:
  `node fixtures/m2/input/tools/check-input-fixtures.mjs`
  (`--write` canonicalizes the JSON and rewrites `index.json`).

## Pins

The sequence pins name the accepted sections the arithmetic comes from:
`docs/contracts/runtime.md` §12.5.2/§12.5.3 (promoted: press latch,
quantization) and the Gate-E-accepted `docs/planning/m2-contracts/input.md`
§4.2/§4.3/§5.3/§5.4 (dead zone, arbitration, suspension, hot disconnect). The
proposal file is pinned because the I-5 promotion copied the sampling model
into `docs/contracts/runtime.md` but not the device-binding sections — packet
30's contract-change request C30-1 records the gap (see
`docs/acceptance/evidence-m2/30/manifest.md`).

## Verification status

Node-verified: every frame/state in `raw-sequences.json`, by this checker and
by the `packages/input` tests. **Browser and physical-controller behavior is
UNVERIFIED** in this container (no browser, no gamepad hardware); the named
desktop procedure is `tests/browser/m2-input/m2-input.browser.ts` and the
packet-37 walkthrough. No synthetic-gamepad-only claim is made.
