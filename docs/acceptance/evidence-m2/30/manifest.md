# Packet 30 — Keyboard and gamepad actions: evidence manifest

Packet 30 (`docs/planning/m2-packets.md` §30), gate H. Owner pre-approval:
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final
manual review pending.** No git commit was made. Not started: packet 31.

## Outcome (one line)

Focused browser input becomes bounded, testable action frames: a new
`@thirdlight/input` workspace package with a pure `mapRawInput` mapping, a
single explicit browser listener owner `attachBrowserInput`, and a replayable
step-indexed `createStepInputSource` for tests.

## Artifacts and what each establishes

| Artifact | Claim |
|---|---|
| `01-toolchain.txt` | environment (Node/npm/tsc/esbuild/vitest versions, host); no browser/hardware in this container |
| `02-input-tests.txt` | `npx vitest run packages/input` — 4 files / 78 tests passed (pure mapping, browser owner through injected fakes, step source, public surface) |
| `03-checks.txt` | `npm test` (root) 106 files / 1401 passed; `npm run typecheck` clean (12 packages) |
| `04-checks-2.txt` | `npm run check-boundaries` OK (12 packages / 235 files / 861 specifiers, 0 violations); `npm run build` 4 built / 0 skipped; contracts fixture checker 34/34; input fixture checker green |
| `05-negative-boundary-probe.txt` | the disposable probe (`three` import, runtime **value** import, `node:fs`) fails check-boundaries 3/3; removed; the tree is green afterwards |
| `06-raw-to-frame-table.md` | every committed raw-snapshot → expected-frame row |
| `07-lockfile-delta.txt` | lockfile delta limited to the `@thirdlight/input` link + workspace package entry |
| `08-final-verification.txt` | the final re-run of every required check on the frozen tree (test 106/1401; typecheck/check-deps/check-boundaries/build exit 0; both fixture checkers green) |
| `fixtures/m2/input/{raw-sequences.json,index.json,tools/check-input-fixtures.mjs}` | 9 sequences / 38 steps re-derived by an independent plain-Node implementation; SHA-256 index; pins resolve to real headings |

## Acceptance criteria (A11, A13; `docs/planning/m2-acceptance.md` §5.2)

- **PASS (Node)** — pure exact frames: keyboard A/D + arrows + Space; standard
  gamepad axis 0 / D-pad 14–15 / button 0; 0.2 dead zone including the exact
  boundary; linear rescaling; deterministic keyboard → D-pad → stick
  precedence with no summation; non-standard mapping and absent device
  ignored; press latch including key-repeat coalescing; press/hold/release
  chain; simultaneous sources OR into one edge; quantization round-trips
  through JSON (`fixtures/m2/input/**`, `mapping.test.ts`).
- **PASS (Node, fakes)** — listener owner: text-field suppression (editable
  `event.target`, no `preventDefault` while suppressed), hidden tab/pagehide/
  blur/target-focus suspension with fresh activation (`held`, never `pressed`,
  before a real up→down), hot disconnect and index reuse with no phantom edge,
  lowest-index active pad, structured `input_unavailable` once per attach for
  absent/insecure/throwing `getGamepads`, keyboard-only degradation, and
  idempotent `detach()`/`dispose()` that removes every listener and clears
  held state (`browser.test.ts`).
- **PASS (Node)** — replayable step source: same frames as a live binding,
  one sample per index, neutral unlisted steps (settle pre-roll), strict
  ascending index validation, no-op `reset` (`step-source.test.ts`).
- **PASS (Node)** — module boundary: `input → runtime` types only; the
  forbidden edges fail check-boundaries (probe 05).
- **UNVERIFIED — physical keyboard, physical controller, real browser**
  (A11's hardware half; also A13's real tab-resume check). No browser, WebGL or
  gamepad exists in this container, so no physical-device or browser-log
  evidence is claimed. **No synthetic-gamepad-only claim is made**: the fake
  DOM/gamepad objects drive listener logic, not device behavior. The named
  desktop procedure is `tests/browser/m2-input/m2-input.browser.ts` (packet-37
  walkthrough; OS/browser/version, `Gamepad.id`/`mapping`, secure-context
  status and `allow` attribute, console frame logs and real PNGs).
- **BR-3 note (owner decision, `docs/handoffs/m2-plan-review.md` §BR-3).**
  `navigator.getGamepads()` availability varies in non-secure contexts, and the
  `gamepad` Permissions-Policy defaults to `*` while a cross-origin iframe
  needs `allow="gamepad"` (live MDN, consulted 2026-09-19: Permissions-Policy
  `gamepad`; `Navigator.getGamepads()` `SecurityError` when blocked by policy;
  the Gamepad API guide's Firefox visible/interacted-page restriction). The
  M1 preview iframe (`packages/editor/src/ui/App.tsx`) sets no `allow`
  attribute and `sessions.md` §13 does not specify one. If the pad is not
  exposed on the plain-HTTP LAN topology in the separate-origin preview frame,
  A11's hardware half cannot pass and the owner must choose the topology
  (localhost access on the backend host, or TLS termination) before the
  packet-37 procedure — no packages/services were installed to force it.

## Package/bundle registration

`tools/check-boundaries.mjs` gains `input` in `UNITS` and one
`NODE_SIDE_ALLOWED.input` row (`packages: ['runtime']`, `typesOnly: { runtime:
true }`), exactly per `dependencies.md` §2 (unit row), §4.1 (`input | runtime
(types)`) and §4.3 (forbidden edges). No `BUNDLE_ENTRY_EDGES` change was needed:
that table checks the *direct* edges of the two app-entry files, and neither
`preview-bootstrap.ts` nor `export-bootstrap.ts` imports `input` yet (packets 35
and 36 wire the preview/export bootstraps); the transitive esbuild-metafile
graphs already allow `input` in the §4.2 preview/export rows. No bundle was
changed by this packet (`npm run build` output is the same four artifacts).

## Contract-change requests
- **C30-1 (promotion gap; binding for later packets).** Gate E accepted I-5
  (`input.md` → `runtime.md`, `dependencies.md`, `delivery.md`) and the
  proposal header says "PROMOTED", but the promotion materialized only the
  sampling model (`input.md` §3 → `docs/contracts/runtime.md`
  §12.5.1–§12.5.3). The device-binding rules (mapping defaults, dead zone,
  arbitration, text-field suppression, suspension/fresh activation, hot
  disconnect, unavailable/blocked API, attachment/disposal) exist only in
  `docs/planning/m2-contracts/input.md` §4–§5, while preserved
  `docs/contracts/runtime.md` text cites `input.md §4` etc. Proposed diff
  (docs-only, replacement text): add `runtime.md` §12.5.4–§12.5.8 with the
  `input.md` §4–§5 text verbatim (or promote `input.md` as
  `docs/contracts/input.md` and repoint the existing references). Packet 30
  implemented against the Gate-E-accepted proposal plus the
  `m2-acceptance.md` §5.2 constants; nothing here changes accepted text.
- **C30-2 (ambiguous prose, pinned to the accepted fixture).** `input.md` §4.3
  item 1 says "if both `KeyA` and `KeyD` … are held, `moveX = 0`", while the
  accepted packet-17 fixture `M3-both-keys-cancel` expects the two keys to
  cancel each other and the stick to apply (`moveX 0.75` for `stickX 0.8`).
  Packet 30 implements and pins the fixture reading (`S9`). Proposed diff:
  rewrite §4.3 item 1 as "the two keys cancel each other (no keyboard
  contribution); the D-pad and stick precedence below still apply".
- **C30-3 (export row).** `dependencies.md` §3's `input` row lists six names
  but the packet requires a separate injectable step-input source. Packet 30
  exports `createStepInputSource` (and its `StepInputStep` type) in addition.
  Proposed diff: add `createStepInputSource`/`StepInputStep` to the row, or
  mark the row non-exhaustive.
- **C30-4 (rounding tie direction).** `runtime.md` §12.5.3 says
  `round(halfAwayFromZero(…))`, while `packages/runtime/src/actions.ts`
  `quantizeMove` uses `Math.round` (half toward `+∞`); all other shipped M2
  code and the frame validator use the runtime implementation. Packet 30
  matches the validator so every emitted frame passes `validateActionFrame`.
  Proposed diff: state `Math.round` in §12.5.3, or change the runtime (would
  only affect exact negative ties and re-derive trace bytes).
- **C30-5 (preview iframe policy; BR-3).** `sessions.md` §13 does not require
  `allow="gamepad"` on the preview iframe. Proposed diff: add to §13.1 "the
  preview `<iframe>` carries `allow="gamepad"`" and add the attribute in
  `packages/editor/src/ui/App.tsx` when packet 35 attaches input in the
  preview (packet 30 may not edit the editor).
- **C30-6 (latch during awaiting-release).** Following packet 17's accepted
  `mapRaw` semantics, a tap that begins and ends entirely inside an
  awaiting-release window (latch set, `downNow` false at the sample) yields
  `none` and is discarded. Proposed diff: state explicitly in §5.3 whether such
  a tap must be preserved as a later edge or may be dropped.

## Verification status summary

Node/CI-verified on this tree: package tests, root tests, typecheck,
check-deps, check-boundaries (incl. the negative probe), build, contracts
fixture checker 34/34, input fixture checker. **Browser, WebGL, physical
keyboard and physical-controller behavior: UNVERIFIED** (no browser or
hardware in this container; packet-37 procedure above). M1 regression: root
test count 102→106 files, 1323→1401 tests, all passing; no M1 fixture,
package or contract changed by this packet.
