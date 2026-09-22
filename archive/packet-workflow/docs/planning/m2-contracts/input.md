PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative. The device-binding §§4–§5 promotion was completed by the Gate H bounded repair (2026-09-19): they now live as `docs/contracts/runtime.md` §12.5.4–§12.5.8 (with the C30-2 both-keys-cancel and C30-6 awaiting-release-tap diffs applied there).

# Thirdlight — Input and action-frame contract (M2)

**PROPOSED — pending Gate E.** Packet 17 output (`docs/planning/m2-packets.md` §17).
Companion documents of the same packet:

- [`platformer.md`](platformer.md) — the controller that consumes these frames.
- [`physics.md`](physics.md) — the injected 2.5D physics port.
- [`diffs/runtime.md`](diffs/runtime.md) — exact section-level changes to
  `docs/contracts/runtime.md` (§2/§3/§4/§5/§5.1/§6/§7/§8/§9/§10/§11).
- [`diffs/project-model.md`](diffs/project-model.md) §"Packet 17 additions" —
  the `schemaVersion` 2 `controller`/`collider` components and the gameplay
  settings registry.

Nothing in `docs/contracts/` or `docs/decisions/` changes until the Gate E
promotion step (docs-only). Nothing here is implemented by packet 17.

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.**

**Physics selection (recorded here, decided in [`physics.md`](physics.md) and
decision 0002 §1):** `@dimforge/rapier2d-compat` exactly 0.20.0, kinematic
character controller — selection per decision 0002 §1, owner pre-approval
(autonomous M2 build instruction, 2026-09-18); final manual review pending.
PROVISIONAL until packet 14's desktop evidence and Gate E accept it; the pin
enters the lockfile only at packet 31.

Normative keywords **must**, **must not**, **should**, **may** are used in the
RFC 2119 sense.

---

## 1. Scope and ownership

This contract owns:

- The **step-indexed `ActionFrame`** — the only input value the runtime core and
  the controller ever see.
- The **sampling model**: one frame per *executed* fixed step, the press latch,
  the no-queue rule, and the catch-up/edge rules (with `runtime.md` §5).
- The **device binding** (package `input`): keyboard and standard gamepad
  mapping, dead-zone rescaling, simultaneous-source arbitration, suppression and
  lifecycle (focus, text fields, visibility, hot disconnect, fresh activation).
- The **replay source** (`RecordedActionSource`) and the replay tolerances.
- Input diagnostics counters and the input failure outcomes.

It does **not** own: the fixed-step scheduler, the phase order, transform
ownership or fail-stop (`runtime.md`, diffs in `diffs/runtime.md`); the
controller math, jump windows and settings values ([`platformer.md`](platformer.md));
the physics world ([`physics.md`](physics.md)); any authoring command or UI.

| Unit | Proposed ownership |
|---|---|
| `runtime` | the `ActionFrame` type, the `ActionSource` port, the per-step sample call, diagnostics counters |
| `input` (new) | pure mapping (`projectRawInput` → `ActionFrame`) plus one explicit browser attachment entry (`attachBrowserInput`); imports `runtime` types only |
| `editor` | hosts the attachment and passes the source into `instantiateRuntime` (packet 30); no mapping code |

**No raw DOM or Gamepad object may cross into the runtime core (normative).**
`ActionFrame` contains only numbers and one string enum. The `input` package is
the only package allowed to touch `window`, `document`, `KeyboardEvent`,
`navigator.getGamepads()` or `GamepadEvent`.

## 2. `ActionFrame` (strict shape)

```ts
type JumpPhase = 'none' | 'pressed' | 'held' | 'released';

interface ActionFrame {
  stepIndex: number;   // integer, 0 ≤ v ≤ 2^53−1
  moveX: number;       // finite, −1 ≤ v ≤ 1, quantized to 1e-4 (see §3.3)
  jump: JumpPhase;
}
```

Canonical key order `stepIndex, moveX, jump`; unknown fields are invalid
(`field_unexpected`). The JSON form of every frame in a fixture is exactly the
canonical form of this shape.

| Field | Constraint | Failure |
|---|---|---|
| `stepIndex` | integer, `0 ≤ v ≤ 2^53−1` | `input_frame_invalid` (`field: "stepIndex"`) |
| `moveX` | finite, `−1 ≤ v ≤ 1`, `round(v·1e4)/1e4` (negative zero → `0`) | `input_frame_invalid` (`field: "moveX"`) |
| `jump` | one of the four `JumpPhase` values | `input_frame_invalid` (`field: "jump"`) |

`jump` is a **phase**, not a pair of booleans, so a frame is self-describing and
replayable:

| Value | Meaning |
|---|---|
| `none` | jump control up in this frame and up in the previous frame |
| `pressed` | down in this frame, up in the previous frame |
| `held` | down in this frame and down in the previous frame |
| `released` | up in this frame, down in the previous frame |

**Neutral frame (normative):** `{ stepIndex: n, moveX: 0, jump: 'none' }`. Every
step without a sampled frame (pre-roll, unlisted replay index, suspended
binding) uses the neutral frame for that step index. A neutral frame is a real
frame: it still ends the `held`/`pressed` chain, so a subsequent `pressed`
requires an actual up→down transition.

`ActionFrame` is the **only** input vocabulary: no button codes, no axis raw
values, no device ids, no timestamps, no `pressedAt` wall-clock fields. Wall
time never enters the runtime (runtime.md §5 step rule).

## 3. Sampling model

### 3.1 One frame per executed fixed step

The runtime calls `ActionSource.sample(stepIndex)` **exactly once per executed
fixed step**, before any module phase of that step, and passes the returned
frame to every phase of that step (`diffs/runtime.md`, §5.1 phase order). Because
`stepIndex` advances only for executed steps (runtime.md §5.3) and each index is
executed at most once in a runtime instance:

- a frame is never sampled twice;
- a dropped wall-time interval produces **no** frames, no steps and no module
  calls — there is nothing to replay (see `fixtures/m2/contracts/runtime/catchup.json`);
- catch-up can therefore never multiply a jump edge.

### 3.2 Press latch — exactly one edge per executed step

A physical tap can begin and end between two samples. The binding therefore
keeps one boolean `downLatch` per jump control source:

1. a keydown / button-down transition observed since the previous sample sets
   `downLatch = true` (a keyup does **not** clear it);
2. at `sample(n)` the observed down state is `downNow || downLatch`;
3. the latch is cleared **after** that sample is produced, in the same call.

Consequences (normative, and asserted by fixtures):

- a tap shorter than one fixed step produces exactly one `pressed` frame, at the
  first executed step after the tap;
- one physical press can never produce two `pressed` frames;
- the latch is not a queue: at most one pending edge per source exists, and a
  second tap before the next executed step coalesces into the same single
  `pressed`;
- a `pressed` frame received while the previous frame was also
  `pressed`/`held`-down cannot occur from the binding — the frame sequence from
  one source is always a valid phase chain (`none → pressed → held* → released
  → none`), and a malformed chain is rejected in replay (§6).

Keyboard auto-repeat (`event.repeat === true`) never creates a latch: repeat
events are ignored.

### 3.3 Quantization

`moveX` is emitted as `round(halfAwayFromZero(clamp(v, −1, 1)) · 1e4) / 1e4`, so
every frame round-trips exactly through JSON and recorded traces compare
bit-exactly. Negative zero is normalized to `0`. Digital sources emit exactly
`−1`, `0` or `1`.

## 4. Device binding (package `input`)

### 4.1 Mapping (M2 defaults, normative)

| Source | Move left | Move right | Jump |
|---|---|---|---|
| Keyboard | `KeyA` or `ArrowLeft` | `KeyD` or `ArrowRight` | `Space` |
| Standard gamepad (`mapping === 'standard'`) | left stick axis 0 < 0, D-pad button 14 | axis 0 > 0, D-pad button 15 | primary face button (button 0) |

Only these mappings exist in M2. A gamepad whose `mapping` is not `'standard'`
is **ignored** and reported once as `input_mapping_unsupported` (device id
clipped to 64 log-safe chars); there is no remapping UI and no user mapping file
in M2. Pointer, mouse, touch, `Gamepad.hapticActuators` and non-standard axes
are out of scope.

### 4.2 Gamepad dead zone and rescaling

Radial dead zone `GAMEPAD_DEAD_ZONE = 0.2` applied to axis 0:

```text
a = |axis0|
if a <= 0.2:        stick = 0
else:               stick = sign(axis0) · (a − 0.2) / (1 − 0.2)
```

The result is clamped to `[−1, 1]` and quantized per §3.3. D-pad presses emit
exactly `±1` (no ramp). A trigger/axis below the dead zone contributes nothing.

### 4.3 Simultaneous-source arbitration (deterministic, no summation)

Per step, from the currently held sources:

1. **Digital first:** if a keyboard move key is held, `moveX` is its exact
   `−1`/`1`; if both `KeyA` and `KeyD` (or both arrows) are held, `moveX = 0`
   (`+1` and `−1` cancel, they are never summed into `2`).
2. Else if a D-pad button is held, `moveX` is its exact `±1`.
3. Else `moveX` is the rescaled stick value of the active gamepad (§4.4).
4. Else `moveX = 0`.

Keyboard beats D-pad beats stick; that fixed precedence is the whole rule — the
binding never sums or averages sources, so `moveX` can never leave `[−1, 1]`.
Jump is the **logical OR** of the mapped controls across the active sources
(down if any is down); the phase chain is computed once, on that OR, so two
simultaneous sources still produce one edge.

### 4.4 Active gamepad

The active gamepad is the connected standard-mapped pad with the **lowest
`index`** that shows any control above the dead zone (or a pressed button)
during the polling window. While a pad is active it stays active until it is
disconnected (§5.4) or another lower-index standard pad becomes active. Exactly
one pad contributes to a frame.

## 5. Suppression, lifecycle and fresh activation

### 5.1 Text-field suppression (keyboard only)

While the runtime owns the input, keyboard events whose target is an editable
element (`input`, `textarea`, `select`, or an element with
`isContentEditable === true`) are ignored: no held state, no latch, no
diagnostic. Editable targets are detected per event from `event.target`
(the binding must not read `document.activeElement` inside a `keydown` handler
to decide suppression). While suppressed, the mapped keys must not
`preventDefault` typing. Gamepad input is **not** suppressed by text fields
(a gamepad cannot type); this is a recorded, deliberate M2 decision, not an
oversight.

### 5.2 Ownership of default browser actions

While attached and `running`, the binding calls `preventDefault()` on the
mapped jump keys so that `Space`/arrows do not scroll the page. It never
captures keys that are not mapped, and never attaches a global
`keydown` capture that swallows editor shortcuts (the attachment is scoped to
the play host element plus `window` for release events, and the binding is
detached on `stop`/`dispose`).

### 5.3 Suspension: focus loss, hidden tab, page hide

All four events — `window.blur`, `document.visibilityState !== 'visible'`,
`pagehide`, and `window` losing the play host — put the binding into
`suspended` state:

1. every held state is cleared, every latch is discarded, and the jump control
   is forced up;
2. the next executed step receives a **neutral frame**;
3. every mapped control enters **`awaitingRelease`**: while a control is
   `awaitingRelease`, a physically down control yields `held` — never `pressed`
   — and the state returns to normal only after the control is observed up
   once;
4. a diagnostic counter is incremented (`inputSuspendCount`), and
   `inputActivateCount` on resume; both are diagnostics-only (no error).

**Fresh activation after resume (normative):** no jump edge can be produced
from state that existed before a suspension. A new jump therefore requires a
real up→down transition observed after resume. This is the observable rule
behind "fresh activation after resume" and it is what the pre-resume `awaitingRelease`
state implements.

### 5.4 Hot disconnect

`gamepaddisconnected` for the active pad: its held state and latch are cleared,
its controls enter `awaitingRelease` (§5.3 item 3), the next frame is neutral for
that pad's contribution, and `inputDisconnectCount` is incremented. Another
connected standard pad may become active under §4.4, subject to the same
`awaitingRelease` rule (no phantom `pressed` from a button that was already
down). Connection and disconnection must work without restarting play.

### 5.5 Unavailable or denied API

If `navigator.getGamepads` is missing, throws, or returns an empty list because
the context is not secure / the `gamepad` Permissions-Policy is denied, the
binding stays operational for keyboard and reports `input_unavailable`
(`reason: 'gamepad'`) once per attach. Keyboard-only play remains available and
no step is ever skipped; play must not fail because no gamepad exists. The
browser/secure-context/topology evidence is packet 14's desktop procedure and
packet 30/35's; this contract only fixes the runtime-visible behavior.

### 5.6 Attachment and disposal

`attachBrowserInput({ target, onDiagnostic })` returns an `ActionSource` whose
`dispose()` removes **every** listener and timer it installed and releases
retained `Gamepad` references; disposal is idempotent and safe before the first
sample and after suspension. The runtime never calls `dispose()` on a source it
does not own: the host that attached it disposes it (the runtime only reports
`tick`/lifecycle state). A source handed to `instantiateRuntime` must not have
been disposed; a disposed source is `input_source_invalid`.

## 6. Replay sources and tolerances

`RecordedActionSource` (test/engine harness; `runtime` package):

```ts
createRecordedActionSource(frames: readonly ActionFrame[]): ActionSource
```

- construction validates every frame (§2), the strict ascent of `stepIndex`
  (strictly increasing; duplicates or regressions are
  `input_frame_invalid`), and the phase chain of the `jump` column (§3.2). The
  first frame may start at any index; every index without a frame yields the
  neutral frame (§2), which is exactly how the settle pre-roll (steps 0–11) is
  represented;
- `sample(n)` is a pure lookup; `reset(reason)` is a no-op for a recorded
  source (recorded sequences must not silently change on focus events);
- a recorded sequence is an **engine-level** fixture: it replays
  identically in the Node harness, the preview bundle and the export bundle.

**Replay tolerances (contract values, asserted by packet 29–36):**

| Comparison | Tolerance |
|---|---|
| same runtime build, same JS/WASM engine, same recorded frames | **exact** — every authoritative `position` component and controller state value bit-identical |
| same build, same engine, repeated process/browser session | ≤ `1e-6` m absolute per component (no cross-step drift accumulation allowed beyond this) |
| same pinned sources, different browser JS engine (preview vs export host, acceptance A22) | ≤ `1e-3` m absolute per component at every sampled step and on the final position |
| cross-platform bit-exactness | **not claimed** (WASM is deterministic per engine, not across engines) |

The tolerance applies to the *authoritative* step state, not to the read-only
interpolated render state (§6 of `runtime.md`, unchanged).

## 7. Observable failure outcomes

| Class | Code / reason | Observable outcome | Durable effect |
|---|---|---|---|
| malformed frame (recorded source, at construction) | `input_frame_invalid` (`field`, `frameIndex`) via `config_invalid` | `instantiateRuntime` → `{ ok: false }`; no runtime instance, no steps | none |
| malformed frame (any source, at sample time) | `module_error` (`reason: 'input_frame_invalid'`) → **fail-stop** | simulation fails at that step; last completed render state retained | none (snapshot untouched) |
| non-standard gamepad | `input_mapping_unsupported` diagnostic | pad ignored; keyboard/other pads unaffected; play continues | none |
| gamepad API missing/denied | `input_unavailable` (`reason: 'gamepad'`) diagnostic | keyboard play continues; no steps skipped | none |
| focus loss / hidden tab / pagehide | `input_suspend` diagnostic + neutral frame + `awaitingRelease` | no phantom movement or jump; resume requires fresh activation | none |
| hot disconnect | `input_disconnect` diagnostic + neutral + `awaitingRelease` | no phantom jump; another pad may take over after release | none |
| disposed source handed to the runtime | `config_invalid` (`reason: 'input_source'`) | `instantiateRuntime` → `{ ok: false }` | none |
| source throws during `sample` | `module_error` (`reason: 'input_source_threw'`) → **fail-stop** | as above; the source is not retried | none |

## 8. Public exports (proposed)

`@thirdlight/runtime` (types only, added to the existing surface):

```ts
export type { ActionFrame, JumpPhase, ActionSource, ActionSourceDiagnostic } from './types';
export function createRecordedActionSource(frames: readonly ActionFrame[]): ActionSource;
```

`@thirdlight/input` (new package, `exports: { ".": "./src/index.ts" }`):

```ts
export type { RawInputSnapshot, InputBindingOptions } from './types';
export const GAMEPAD_DEAD_ZONE: 0.2;
export const DEFAULT_KEYBOARD_MAP: Readonly<{ left: string[]; right: string[]; jump: string[] }>;
export function mapRawInput(raw: RawInputSnapshot, stepIndex: number, prev: { down: boolean }): { frame: ActionFrame; next: { down: boolean } };  // pure
export function attachBrowserInput(options: InputBindingOptions): ActionSource;   // the only DOM entry
```

`@thirdlight/editor` hosts `attachBrowserInput` inside the play host and passes
the returned source into `instantiateRuntime` (packet 30). `@thirdlight/protocol`
carries `ActionFrame` values over the input relay as plain data (packet 35); the
bridge adds no second mapping implementation — the relay uses the same frame
shape and the recorded-source validation.

## 9. Constants (normative; M2)

| Constant | Value | Kind |
|---|---|---|
| `GAMEPAD_DEAD_ZONE` | `0.2` | hard constant |
| `MOVE_QUANTUM` | `1e-4` | hard constant |
| `MAX_JUMP_CONTROLS_PER_SOURCE` | `1` pending edge (the latch) | hard constant |
| keyboard map | A/D, arrows, Space | M2 default (no remap UI) |
| gamepad map | standard mapping, axis 0, buttons 0/14/15 | M2 default |
| neutral frame | `moveX 0`, `jump 'none'` | hard rule |
| pre-roll frames | steps 0–11 are neutral (`platformer.md` §6) | hard rule |

## 10. Compatibility and change rules

- M2 **adds** the `ActionFrame`/`ActionSource` surface; no accepted M1 behavior
  changes. `instantiateRuntime`'s config gains an optional `actions` field
  (default: a source that always returns neutral frames, so every existing M1
  caller and test keeps its exact behavior — `diffs/runtime.md` §3.1).
- Adding a mapping, changing the dead zone, changing the quantization, or
  changing the phase-chain rule is a reviewed contract change (it changes replay
  bytes).
- The runtime core must stay DOM-free and three-free (runtime.md §9): adding a
  DOM import to `runtime` is a boundary violation, not a convenience.
- A recorded sequence is part of a test's contract: changing a committed
  fixture's frames changes the expected trace and requires the dependent
  fixtures to be re-derived in the same change.

## 11. Deliberately not in M2

- No remapping UI, mapping profiles, per-project input bindings, dead-zone
  sliders or trigger thresholds.
- No pointer/mouse/touch/virtual-stick input; no keyboard-only alternate
  movement sets; no macros, chords, double-tap/jump-cut, or press timings.
- No input recording UI, no network input beyond packet 35's bounded relay,
  no replay of player input into authoring state.
- No rumble/haptics, no gamepad LEDs, no multi-pad simultaneous movement.
- No wall jump, no double/air jump, no crouch/dash/attack inputs (platformer.md
  §9; those are M3 design inputs, not hidden M2 features).
