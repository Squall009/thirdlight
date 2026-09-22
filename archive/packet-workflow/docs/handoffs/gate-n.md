# Gate N — packet 55 review (in-session)

**Verdict: ACCEPTED.**

Reviewed in-session (no sub-session available — host constraint).

## Scope

Packet 55 (delivery.md §§3–4; dependencies.md §3/§4.1 rows for
`game-host` + `input`): the start/completion HUD and the single-owner game
controls — the local (in-page) game shell in `@thirdlight/game-host`
(`createGameHost`), the host-owned text-node HUD, the menu/control channel
consumed between frames, the committed-view cue wiring, and the input
package's approved menu-control seam.

## A. Toolchain re-run (fresh, 2026-09-21T00:02Z — /tmp/gate-n-toolchain.txt)

- `npm test`: **164 files / 2049 tests passed**, exit 0.
- `node tools/typecheck.mjs`: 17 packages OK. `node tools/check-deps.mjs`:
  all exact versions. `node tools/check-boundaries.mjs`: 17 packages / 318
  files / 1228 specifiers, **0 violations**. `node tools/build.mjs`: 4
  built, 0 skipped.
- M2 checkers: contracts 34/34; course/runtime/physics/input exit 0. M3
  checkers: contracts, gameplay, media (14 groups), delivery, storage,
  audit 8/8, promotion — all passed; media corruption control 10/10
  detected (clean tree exit 0); delivery negative control passed (both
  corruptions rejected).
- Frozen fixture bytes: untouched by packet 55 (no fixture edits; all
  digest-pinned checkers re-run green above).

## B. Reviewer-side verification pass

**B1. §3.1 surface, member by member** — re-derived against
`packages/game-host/src/host.ts`: `GAME_HOST_API_VERSION = 1` ✓;
`GameControlAction`/`GAME_CONTROL_ACTIONS` (the four actions) ✓;
`GAME_HOST_MESSAGES` (the four bridge names, verbatim) ✓; `GameHostConfig`
(snapshot/settings/physics/adapter/input/audio/readArtifact/container —
all present; `readArtifact` in the contract's `Promise<ArrayBuffer>`
shape) ✓; `GameHostObservation` (runId/snapshotId/buildId/stepIndex/state/
checkpointId/deathCount/goalReached/failed/sound{status,unlocked,voices,
muted,gesture}/inputMode) ✓; `GameHost` — `mount(): {ok:true}|{ok:false,
error:{code}}` (no value field), `control: {ok:true, state,
acceptedAtStep}|{ok:false, error:{code, reason?}}`, `observe(): {ok:true,
observation}|…`, `setViewport`, `dispose(): void` (idempotent) — all the
binding shapes ✓. `createGameHost(config)` ✓.

**B2. §3.1 rules** — browser-safe by construction: the game-host imports
only runtime (types + the accepted values + `BUILTIN_MODULES` — see F3
below), platformer, platformer-game (values) and input (types only); no
editor/exporter/backend/workspace/commands/protocol/mcp/asset/behavior/
physics-rapier/three import, no Node builtin import, no fetch (the
artifact reader is injected) ✓. HUD text: `textContent` only — the
malicious-title case is test-pinned (markup renders literal; the fake DOM
audits `innerHTMLWrites === 0` over every HUD node) ✓. Checkpoint bit from
the committed `GameView` (`checkpointActive`) ✓; no
checkpoint-activation appearance (that is 41/52) ✓. `dispose()` removes
the host-owned listeners/DOM/adapter/runtime idempotently; the injected
input/audio owners are wrapper-owned and NOT disposed (a new host reuses
them — the §3.1 reuse clause) ✓ (test: the second host on the same
snapshot + same owners mounts cleanly; `input.disposed === false`).
Single production composition: the host is the only place the M3 module
set/registry/frame wiring are assembled (the 56/59 wrappers will be thin)
✓.

**B3. §4.1 two channels** — gameplay via the input `ActionFrame` (the
runtime's `actions` source); menu via the owner's `sampleMenu()`/
`markConfirmConsumed()` — separate channels, different rates (the menu
latches are host-consumed per frame; the gameplay sampler reads the
latch-free `suppress()` state); a menu action never enters an
`ActionFrame` (the seam zeroes contributions; it injects nothing) ✓.

**B4. §4.2 fresh release (independent re-derivation)** — the mapping's
`jumpDownOf` derives the jump down-transition from the HELD keyboard
state (`keyboardJump = anyHeld(JUMP_CODES)`), not from the owner's press
latch; therefore a consumed Space held down would still emit
`pressed`/`held` unless the suppression zeroes the HELD contribution —
`browser.ts` does exactly that (`keyboardJumpSuppressed` zeroes
`keyboardJump` in the snapshot; the pad case zeroes `button0`), and the
release clears the consumed state (`keyboardUp` always releases the menu;
the pad release clears `padConfirmConsumed`). Verified at three levels:
the pure controller (`menu.test.ts`), the real owner over a fake window
(`browser-menu.test.ts` C1/C2: held consumed press → neutral frames;
fresh press after release → `pressed` then `held` — no early
`released`), and the full real-physics shell (`tests/m3-shell` C1/C2: 12
grounded steps at spawn height through the run start, then a jump on the
fresh press). The runtime's OWN defenses (gameplay.md §2.5 — the neutral
effective frame at awaitingStart/won + the first-live-step jump gate)
layer underneath; the owner suppression is the binding §4.2 addition.
**Interpretation adjudication:** the host marks a confirm consumed only
when it DROVE a menu action (start at awaitingStart, replay at won); a
confirm sampled in play is a no-op and keeps its jump — §4.2's
"consumed menu press" is the press that acted as a menu action, and the
in-play Space press is gameplay input whose jump must not be truncated
(B15). **ACCEPTED as the faithful reading.**

**B5. §4.3/§4.5/§4.6** — gamepad arbitration is the accepted mapping
(unchanged); disconnect (missing poll entry / index reuse) clears the pad
slice only (`menu.clear('gamepad')` — C7 test: the keyboard confirm
survives; the keyboard jump works after the pad loss). `gameCommand` is
callable between frames (the host services the channel in `onFrame`,
which runs after the step update; `control()` is directly callable
anytime; commands queue and apply at the next boundary — at
awaitingStart/won that boundary performs no motion steps, so C4/C5
succeed with `movementSteps: 0` — m3-shell asserts the player is still at
the spawn after the start). Hidden/focus: the input owner suspends
(held keys + the menu latch clear — `menu.clear('all')` on
suspend/blur/visibility) and the runtime's bounded catch-up
(`MAX_CATCHUP_STEPS = 8` + drop-and-resync fresh anchor) covers the
frame-time reset — m3-shell C9/§4.6 asserts a 5s wall stall advances ≤ 8
steps and the walk stopped at the hidden edge. The page-level
visibility→`audio.setHidden` wiring lands with the 59 preview wrapper
(the owner-level `setHidden` is 54-verified) — documented.

**B6. Cue wiring (B13)** — the committed `GameEventKind` vocabulary has
no jump event (re-derived: `runStarted|died|respawned|checkpointActivated|
goalReached|replayed`), so the jump cue is derived from the committed
`playerMotion` grounded→airborne transition (bounded, dedupe-able id
`${runId}/jump/${stepIndex}`; a walk-off cliff also fires it — documented
limitation). The host re-submits the bounded event ring every frame; the
owner dedupes by id per runId and drops stale-run events
(`stale_work_discarded` — m3-shell asserts the drop after a replay).
Real fixture bytes: the m3-shell harness feeds the REAL
`fixtures/m3/media/wav/cue-*.wav` through the injected reader into the
REAL owner (fake context) — decode + voice start + `sound.voices ≥ 1`
asserted at the goal. **ACCEPTED as the committed-view-faithful design.**

**B7. §3.1 `state` timing (re-derived)** — §5.1: "`ok: true` reports
acceptance of the submission (the runtime's own rule); `state` is the run
state at acceptance" — the host's `control()` returns the state at
acceptance (a title start reports `awaitingStart`); the §5.1 example JSON
(`state: "playing"`) is the illustrative relay result (the bridge may
post after the boundary). The implementation matches the binding rule
text. **PASS.**

## C. Findings (scope disclosures — none block acceptance)

- **F1:** `tests/m3-shell/` (the root Node suite, 7 tests) is outside the
  packet-55 may-edit list (`tests/browser/m3-shell/**` only). Justification:
  the packet's evidence list (start→win→replay, held confirm→jump,
  gamepad takeover/disconnect, stale run request, hidden-tab resume,
  repeated attach/detach over the REAL Rapier port + the REAL input owner
  + the REAL cue bytes) cannot run in `packages/**` (Node builtins
  forbidden there — `fs` reads the fixture bytes; the `tests/**` root is
  the established home for Node real-parts suites — tests/m3-gameplay,
  tests/m3-audio pattern). Accepted as a necessary evidence addition
  (the CC-51-1 disclosure pattern).
- **F2:** `tools/check-boundaries.mjs` — the game-host row update
  (runtime/platformer/platformer-game packages + input typesOnly). The
  table is the recording mechanism for the approved §4.1 edges (the
  packet-54 precedent: the checker/table/tests are the packet's
  boundary-checking scope).
- **F3:** `BUILTIN_MODULES` is a 4th `runtime` VALUE beyond the §4.1 row's
  three named values (`instantiateRuntime`/`createSimulationRegistry`/
  `registerSimulationModule`). The §3.2 composition is binding and
  explicit ("registry (runtime built-ins + platformer controller +
  platformer-game session + linked behavior modules)"), so the registry
  carries the built-ins (registered, NOT selected — the M2
  export-composition pattern). The package edge (game-host → runtime) is
  unchanged. Accepted with the note; no contract diff required.
- **F4:** `packages/input` export surface extended additively
  (`createMenuController`, `MENU_CONFIRM_CODES`, `MENU_MUTE_CODE`,
  `MENU_GAMEPAD_CONFIRM_BUTTON`, the `MenuSample`/`MenuController`/
  `MenuConfirmDevice` types; the owner's `sampleMenu()`/
  `markConfirmConsumed()` methods) — authorized by the delivery.md §4.1
  "approved menu-control seam"; the dependencies.md §3 input row does not
  yet list these (recorded here; a line sync belongs to the next contract
  pass, the C30-3 pattern).
- **F5:** `package-lock.json` +91 lines: 7 workspace link materializations
  (asset-pipeline, behavior-build, game-host, input, platformer,
  platformer-game, physics-rapier — `link: true`, exact `0.1.0`) + the
  `@dimforge/rapier2d-compat@0.20.0` entry (the EXISTING approved pin of
  `physics-rapier`, newly materialized by the workspace re-link; exact
  version + integrity, no new external dependency, no pin changes, zero
  removed lines).

## D. Contract-change requests — adjudication

- **CC-55-1 (additive):** `GameHostConfig.buildId: string` +
  `assetPaths?: Record<string, string>` (+ the `document?: HostDom`
  injection field) — **ACCEPTED.** `GameHostObservation.buildId` is
  unsatisfiable from the binding config (it carries no build identity —
  the wrapper is the party that verifies the manifest identity) and the
  host cannot resolve cue bytes (the manifest is wrapper-owned; the host
  is fetch-free by the §3.1 rule). Additive config fields; the binding
  members are unchanged.
- **CC-55-1b (additive):** the read-only `GameHost.runtime` seam —
  **ACCEPTED.** The binding surface exposes no frame-advance handle; the
  manual-driver/Node compositions and the 59 bridge need one. Read-only;
  throws after dispose (the seam is dropped with the host).
- **CC-55-2 (additive deviation):** `GameHostConfig.adapter` is the
  factory `(runtime) => HostRenderAdapter | null` — **ACCEPTED.** The
  three-adapter instance requires the runtime it renders (its own
  options), which the host creates inside `mount()`; a pre-made instance
  cannot be injected. The host stays three-free (the structural
  `HostRenderAdapter` surface; no three-adapter import).
- **CC-55-3 (open):** no behavior-linking channel in the §3.1 config —
  **ACCEPTED AS OPEN (not implemented).** The 55 composition rejects
  behavior-carrying scenes fail-closed
  (`host_config_invalid`/`behaviors`); the concrete config diff is filed
  by 56/59 if a delivered game carries behavior records.

No application of contract diffs was required at this gate (the CCs are
additive surfaces the packet itself implements; no accepted CC changes an
already-accepted contract's meaning). Frozen fixtures, pins, and the
binding §3.1/§4.1/§4.2 members are unchanged.

## Signature

Gate N: **ACCEPTED** — packet 55 meets its acceptance (B04/B08/B09/B13/
B15 logic halves verified in-container; the browser/physical/audible
halves remain UNVERIFIED per the packet-38 baseline and are owned by the
`tests/browser/m3-shell` procedure + the 62 final witness).

reviewed in-session (no sub-session available — host constraint)
