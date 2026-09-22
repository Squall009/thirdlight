# M3 — One complete short platformer

**DRAFT · 2026-09-19 · planning only; architectural review required.**

Deliverables: [packets 38–62](m3-packets.md), [sample-level brief](m3-sample.md),
[acceptance plan](m3-acceptance.md), [planning handoff](../handoffs/m3-planning.md).
Implements the M3 prompt in `implementation-prompts.md`; no feature, dependency,
contract promotion, service installation or implementation packet is authorized
by this document. All new names, numbers and interfaces below are proposals.

## 1. Baseline and outcome

The owner reports M2 complete and requests M3 planning. Plan against the **current
M2 working tree**, not HEAD alone: HEAD is `5b746ee` (the accepted M1 baseline),
with the M2 implementation/contracts/evidence uncommitted. Preserve that work.
`handoffs/m2-owner-review.md` and `acceptance/m2-report.md` still record 16
UNVERIFIED browser/hardware halves, provisional desktop physics evidence, and an
owner walkthrough. This planning task does not rewrite those historical records
or claim that the missing artifacts were supplied. Packet 38 records the current
owner disposition and the actual M3 browser verification path; no new approval is
inherited from the autonomous **M2-only** pre-approval tag.

Outcome: author, play and export **Beacon Reach**, one small 2.5D level. From a
start screen, move/jump past static hazards, activate one checkpoint, recover from
death, reach a clearly marked beacon, see a completion screen, and play again.
Camera, simple animation, readable lighting, HUD and sound make it a complete game,
not another controller course. Editor Play and the standalone export use the same
production game logic and presentation modules. Backend-owned commands remain the
only persistent editing path; gameplay never edits authoring state.

### Scope commitments

| Include in M3 | Explicit limit |
|---|---|
| One level, title/start and completion/retry screens | One active scene, one player; no scene streaming or game save |
| Static hazards, fall death, one checkpoint, one goal | Non-solid axis-aligned XY gameplay zones, not dynamic physics bodies |
| Respawn and full replay | In-memory run/checkpoint state only; no lives economy or save slots |
| Follow camera | One side-view perspective camera; fixed depth/orientation, dead zone + level bounds |
| Basic HUD and audio | Objective/checkpoint/death count/mute; short non-spatial sound effects; no UI editor or music system |
| Simple runtime animation | Rigid-node GLB idle/run/airborne roles and bounded crossfade; no skeletal animation or animation graph |
| Editable lights/shadows and reusable material presets | One directional light + ambient fill; conservative WebGL 2 shadows; three built-in primitive-material presets copied into entities |
| Editor content work | Import/reimport, independent prefab copies, gameplay/camera/render/audio controls, mixed UI/MCP edits |
| Standalone export | Complete pinned relative closure; independent static server at a non-root URL |

No enemies/AI, combat, inventory, quests, unlocks, Metroidvania progression,
multiplayer, moving/one-way platforms, dynamic bodies, hostile-code sandbox,
linked/nested prefabs, general audio mixer, shader graph, WebGPU parity, template
installer, independent project packaging, or reference-device product budgets.
M4 remains a separately planned reliability/template milestone.

## 2. Accepted constraints and missing APIs

Inputs inspected: charter, M3 planning prompt, M2 plan and owner/acceptance records;
accepted dependency contract and relevant model/runtime/session contract sections;
public runtime/input/model/three-adapter surfaces; the production composition and
preview registration seams. This is a bounded planning inspection, not a code
review or a new test run. References below are to `docs/contracts/` unless noted.

| Gap / accepted boundary | M3 proposal and owner packet |
|---|---|
| `project-model` v2 is a closed registry; assets have only `kind: model`; prefab definitions exclude collider/controller | 39 defines explicit scene/storage v3 and audio/model-version metadata. Preserve v1/v2 readers and copy migration. Keep prefab exclusions: decoration copies, gameplay components added afterwards. |
| `commands` has closed create/setComponent/query/change/inverse unions | 39 specifies every new create/add/edit/remove/read path and its browser/MCP result. No sample JSON patching or direct envelope writes. |
| `runtime.md` §3.1 C35-5: `content.settings` absent from Play/export delivery | 42 captures resolved settings into manifest **v2**, hashes them, and supplies the same values to physics and runtime; 58 implements. Do not add required fields to manifest v1. |
| `runtime.md` §§12–13: one transform owner, three module phases, fail-stop, last completed state | 40 specifies a versioned M3 schedule with post-motion gameplay and camera work plus a reset barrier; 49–51 implement. No change to M1/M2 step math. |
| `PhysicsPort.reset` is tests/diagnostics-only (§12.6); modules receive only `PhysicsStepClient`; controller has private velocity/windows | 40 explicitly proposes a runtime-owned respawn transaction, resetting controller, physics and interpolation together; 50 implements. Calling the current reset from game code is forbidden. |
| No gameplay-zone query, run-state output or lifecycle controls | 40 defines a bounded pure capsule-sweep/zone test and a read-only run view; 42 defines start/replay/mute controls and observations. No universal event bus. |
| Input is movement/jump only; menu controls and stopped-runtime sampling are unspecified | 42 specifies a separate bounded game-control surface using the existing input owner, fresh-release rules and exclusive test mode; 55 implements. Do not poll a second competing gamepad owner. |
| Adapter synchronizes transforms; camera is static, preview clips are local state only | 40 defines camera transform ownership; 41 defines presentation of rigid clip roles through the shared resource owner, not an independent animation loop. |
| `project-model.md` §18.1 forbids persisted glTF subresource references; `clone(true)` shares skeletons | 41 requests a narrowly version-bound semantic-role mapping, with exact replacement text for §18.1. No raw persistent clip names/index references across reimport; no skins in the M3 animation profile. |
| No light components or authored lit primitive materials | 39/41 define bounded v3 data and shared adapter mapping. M1/M2 unlit/GLB behavior is unchanged; presets copy values, not linked catalog entries. |
| No audio profile, byte validation, decoding lifecycle, CSP or closure policy | 41 specifies bounded PCM WAV; 47/48 add inspect/publish via existing immutable blobs; 54 owns browser audio; 58–60 deliver the bytes. |
| `composeExportRuntime` lives in exporter internals; preview registers its own composition | 42 approves one browser-safe public composition entry. 58 moves/reuses existing wiring with compatibility tests; preview cannot import exporter internals. |
| Existing exact import graphs/content scan exceptions are binding | 42 supplies section-level graph/scan changes; 58/60 remeasure and seek bounded re-review if measured text differs. Never blanket-disable scans. |

Each gap has an explicit contract owner **before** implementation. The contract
pack must include a feature-to-authoring-to-runtime-to-export traceability table.
A type or sample fixture without a supported command/UI path does not close a gap.

### 2.1 Plan-review PR-1 repair — sample values with no owner (must close at K)

The plan-review step (handoff `m3-plan-review.md`) found three sample values that
§3.1 named only indirectly. Each now has a named owner and a required K proof; the
feature→command→UI/MCP→runtime→export matrix in packet 43 must show a **creation**
path (not only an edit path) for every one of them:

| Value | Required by | Owner and required proof |
|---|---|---|
| Under-title **instructions text** | sample §2 item 1, sample §4 | 39 owns the bounded string field (max length fixed at K); 55/56 prove it is authored, stored and rendered as a text node. A fixed local constant in `game-host` is an acceptable alternative **only if** 39 records that decision; it may not be left unowned. |
| **Per-checkpoint respawn reference** | sample §3 (“safe spawn X=24”), acceptance B07 | 39 owns an explicit safe-spawn reference on the checkpoint gameplay-zone component (reference rules and deletion semantics identical to the other marker references); 50 consumes exactly that reference. A single global spawn is **not** sufficient for B07. |
| **Checkpoint activation presentation** | sample §2 item 4 (“light/shape change plus cue”) | 41 owns the bounded activation-appearance data (a per-checkpoint material/emissive switch or an equivalent contracted, non-script presentation value) and the read-only view bit the adapter consumes; 52/53/57 realize and author it; 55 does not invent it. Session HUD text alone does not satisfy B08’s checkpoint image requirement. |

Naming rule for the two different “manifests” (plan-review PR-4): the authoring
`project.json` manifest keeps `schemaVersion` 1 (project-model §6/§7 — it stays 1
in M2 and in M3); the runtime-content export `manifest.json` moves
`manifestVersion` 1 → 2 (sessions.md §13, export.md §5). Packets 39 and 42 must
say *which* document they version, and 39 must add the legal combination
`manifest 1 + scene 3 + storage 3` to the project-model §6 and workspace §4.5
tables alongside the existing v1 and v2 rows.

## 3. Proposed design directions (not accepted contracts)

### 3.1 Versioned authoring and durable content — 39, 44–48

Retain one atomic envelope, one authoring revision and immutable source blobs.
Propose scene schema 3 / storage 3, manifest `project.json` still v1; document the
exact legal combinations. New engine readers accept old projects unchanged;
opening an old project never upgrades it. Explicit operator migration copies v2
to a new project identity, retains source bytes, resets revision/history/retry,
and has resumable crash boundaries. v1 may use the existing v1→v2 copy followed
by v2→v3; no in-place upgrade. Freeze fixtures for old and new paths.

Proposed components: gameplay zone (hazard/checkpoint/goal), player spawn marker,
camera-follow settings, bounded directional/ambient light, v3 primitive surface,
and model animation profile. Propose one bounded game configuration block in the
same content catalog: title/objective, player/camera/spawn references, level and
kill bounds, cue asset references. Exact field names/defaults, reference ownership,
limits, canonical order and deletion rules belong to 39/41. No JSON blobs,
arbitrary code/HTML, or a separate mutable game configuration file.

Proposed component coverage explicitly includes the §2.1 values: the bounded
instructions string, and the checkpoint zone's safe-spawn reference and
activation-appearance slot. Packet 39 may not defer any of them to a later
“implementation decision”.

Keep copy-on-instantiation prefab semantics. Decorations use existing model/box
prefabs; zone/controller-bearing entities are not silently made capturable. Copy
refs to models keep their stable asset IDs; deleting a referenced spawn/player/
camera/cue fails or follows a precisely contracted atomic cleanup, never leaves a
dangling reference. Prefer rejection over implicit edits.

Audio uses a distinct asset kind and versioned import recipe. Proposed initial
profile: RIFF/WAVE PCM, mono, signed 16-bit, 48 kHz, at most 2 seconds / 192,000 PCM
bytes per cue, at most six referenced cues. Freeze complete container/chunk and
decoded-byte bounds at K (header overhead is not PCM length). Reject URLs,
compressed codecs, mislabeled kinds, malformed chunks, unsupported channel/rate
formats and oversized decoded output before publication. No decoder library is
needed on the backend: bounded byte inspection only. Immutable metadata and bytes
publish through the same stage → inspect → blob → command sequence as models.

All new fields need pure command validation, inverse/no-change behavior, durable
retry, bounded queries, projection/resync and real HTTP/stdio-MCP coverage. Exact
createEntity kinds and setComponent/add-remove rules must be specified; do not
repeat M2's late model-placement/collider-authoring gaps. Build game configuration
through a typed command, not a second settings document. M2's six gameplay settings
remain separately typed and actually reach both hosts in M3.

### 3.2 Game flow, zones and respawn — 40, 49–50

Proposed run states: `awaitingStart → playing → respawning → playing` and
`playing → won`; `replay` constructs a fresh run from the same captured content.
Runtime failure remains terminal, distinct from death; a failed physics step must
not be converted into a successful respawn. Stop/dispose is valid from every state.
The run owns checkpoint ID, death count and bounded presentation events, not the
authoring scene. No wall-clock gameplay timers or persisted progress.

Gameplay zones are root, unit-scale, axis-aligned XY rectangles; they never block
the character. Use a **pure, explicitly specified swept upright capsule vs zone**
test over the last completed motion segment, with numeric boundary fixtures. This
is a reviewed geometry service, not a second movement/collision solver. It avoids
adding Rapier sensors solely for a handful of static triggers. Teleports do not
sweep across intervening zones. The fall threshold is a separate level bound.

Proposed same-step precedence: death (hazard/fall) wins over checkpoint and goal;
otherwise checkpoint precedes goal; ties within one role use stable ID order.
Repeated overlap activates nothing twice. Freeze enter/exit, touching-edge,
fast-crossing, spawn-inside and goal-from-respawn semantics in 40 fixtures. A
checkpoint can activate once per run; full replay clears it and death count.

Extend only the M3 schedule: consume queued reset at a step boundary → sample →
intent → controller → physics → transform → gameplay → camera → commit. The
contract must pin what each phase reads, how a whole completed presentation view
is published, and which queued effects become visible on the next step. M1/M2
schedules/recorded traces stay unchanged. During awaitingStart/won there are no
movement steps; menu input can still be sampled by the host. During the bounded
respawn delay movement is neutral; the contract fixes exact step/event semantics.

Respawn is **one runtime-owned discontinuity**, not a `setTransform` command or a
behavior-owned player transform. At the approved barrier, verify the destination,
reset Rapier capsule/cached motion, controller velocity/grounding/coyote/buffer/
jump-release state, pending intents/actions and trigger latches; rebase `prev` and
`curr` together and snap the camera. The same module remains player transform
owner. Publish only a coherent successful state; on partial private-world failure,
fail-stop and retain the last committed view (no rollback claim). Invalid/blocked
spawn is a structured failure, not an infinite death loop or fallback coordinate.
Use safe authored spawn points with a real-library clearance check. Jump held
through start/respawn cannot produce a phantom jump.

### 3.3 Camera and presentation — 40–41, 51–54

Follow the player's committed/interpolated pose with a fixed -Z view and Y-up;
no depth lanes, orbit or cinematic camera. Camera math runs under one explicit
runtime owner, not a separate viewport loop. Propose horizontal/vertical dead
zones, bounded fixed-step smoothing, authored XY bounds, and a hard snap on
initial start/respawn/replay. Contract fixtures define frustum-aware clamping at
16:9 and a narrower desktop aspect; resize is presentation-only and never moves
physics. Select exactly one gameplay camera; editor navigation remains independent.

Rendering: use the pinned WebGL 2 path. One directional key, one ambient fill,
optional bounded shadow map, one conservative preset quality. Three built-in
primitive presets (matte ground, hazard, beacon) expand to ordinary serializable
surface values. Preset application is one undoable edit; changing one copy cannot
change another. GLB materials remain authored in the GLB (no material-slot refs).
Unsupported shadows degrade visibly to shadow-off with diagnostics; unavailable
WebGL prevents play with an actionable error. No promise of identical pixels
between GPU drivers or a product performance budget.

Animation: optional rigid-node profile maps semantic roles `idle`, `run`,
`airborne` to validated clip indices **inside one immutable GLB version**. The
version/digest binding is the explicit exception proposed to the M2 no-subresource
rule. Entity data references the profile/asset, never an unqualified clip name.
Reimport submits new mapping and bytes together: missing/ambiguous roles reject
publication for dependent animated entities; reordered clips with equivalent
mappings work; undo restores mapping and bytes. Restrict animated tracks away from
the entity's physics holder; reject skins in this profile rather than pretending
`clone(true)` isolates them. Two instances need independent mixer/action state.
A fixed role selector consumes read-only player motion/grounding; a short crossfade
changes visuals only. No root-motion physics, graph, IK or general blend tree.

Audio: a browser-only owner receives verified bytes and typed committed cue events.
Use Web Audio without a new npm package. Decode bounded cues, cap concurrent voices
(proposal: eight), deduplicate by run/event identity, cancel stale async work, stop
voices/suspend on hidden/stop and close owned contexts on dispose. Gameplay never
waits for audio. User gesture unlock is attempted **inside the preview/game**;
postMessage or MCP input is not a trusted activation. Autoplay denied/muted/absent
audio presents an honest status and a local Enable sound button; keyboard/gamepad
completion still works silently. Corrupt/missing declared audio fails build/load;
policy denial is a nonfatal sound-off mode. No spatial audio, streamed music,
remote files, base64 payloads in WS, or server sound device.

### 3.4 Controls, HUD and shared delivery — 42, 55, 58–60

One narrow browser-safe host package is proposed (`@thirdlight/game-host`), created
only in its implementation packet. It owns game start/replay/mute controls, small
DOM presentation (plain text/buttons, no React dependency), audio lifecycle and
production module composition through injected dependencies. Keep pure game rules
in `platformer-game`; neither unit may import editor/backend/exporter/workspace.
Preview/export wrappers supply artifact readers, canvases and bridge callbacks,
not different game logic. Transfer only existing composition code needed for this
boundary; no broad refactor of M2 hosts.

Start/replay: Enter/Space or a fresh primary gamepad button; moving/jumping remains
M2 bindings. A menu press is consumed and needs release before becoming jump.
Gamepad API denial/disconnect retains keyboard play. Loss of focus/visibility
suspends input/sound and resets accumulated time so resume cannot fast-forward
hazards or replay old edges. Mute is a browser-session preference, not authoring
state or a saved game. HUD text uses text nodes, never project-supplied HTML.
Title/goal text is bounded data. Screen completion/replay must work without mouse.

MCP gains only contracted bounded semantic game controls/observations for an
explicit play session (no eval). Runtime observations carry play/snapshot/build/run
identity, step index, state, checkpoint/death count and sound status. Version any
changed bridge, preserve exact origin/source/nonce checks, bound payloads and
reject stale requests. No-browser requests remain unavailable. Menu controls must
work without awaiting a physics step while the game is at the title/win screen;
exclusive injected input cannot race physical controls or pretend to unlock sound.

Capture v3 scene, game configuration, resolved six-key settings, model role maps
and audio references from **one** acknowledged envelope. Manifest v2 includes or
digest-binds every runtime-affecting field. Its asset discriminators, recipes,
module/API versions and exact path/MIME/size/hash rules are fixed at K. Old manifest
v1 stays readable under its old meaning. Existing `capturedAt` reproducibility
semantics remain explicit: compare two separate output trees and normalize only
the contracted timestamp carriers before re-deriving build identity.

Use the same closure builder for Play/export; verified bytes enter rendering/audio
through injection. No authoring credential, locator capability, absolute workspace
path, CDN/font/audio URL, Node import or compiler enters standalone output. Export
contains HTML/CSS/runtime and every reachable declared GLB/WAV/behavior/WASM
artifact and notices. Static serving under a non-root prefix, CSP/audio permissions,
load cancellation, old Play pinning, stale builds, previous-output preservation and
rendered canvas screenshots plus DOM HUD evidence are explicit acceptance checks.
Do not claim the existing canvas PNG relay captures the DOM overlay.

## 4. Ownership and dependencies

No packages/directories are created by this plan. Gate K must approve exact public
exports, package versions, graph edges and bundle entries before implementation.

| Owner | Proposed responsibility / allowed direction |
|---|---|
| `project-model` | v3 data, validation/migration and pure captured-manifest derivation; remains a leaf |
| `commands` | v3 typed edits and inverses; model only |
| `workspace` | v3 envelopes/copy migration, immutable model/audio publication/reads; remains sole executor |
| `asset-pipeline` | GLB role metadata and bounded WAV inspection over supplied bytes; no decoder/network/rendering |
| `runtime` | M3 scheduling/reset barrier/ports and committed read-only observations; model only |
| `platformer` | existing controller and a narrow contracted reset seam; runtime types only |
| `physics-rapier` | existing real adapter and runtime-only reset/clearance seam; no gameplay rules |
| new `platformer-game` | pure run-state, zone geometry and camera math over runtime ports/types; no concrete physics, input, DOM or three |
| `three-adapter` | lights/materials/shadows and rigid clip realization; owns all GPU/mixer resources; bytes in, no fetch |
| `input` | single browser input owner; movement and bounded menu controls/fresh-release behavior |
| new `game-host` | public browser-safe audio, DOM HUD/control host, shared module composition; explicit runtime/input/platformer/platformer-game/physics/adapter injection/composition edges approved at K |
| `protocol`, `backend`, `mcp-adapter` | bounded wire schemas, existing services and explicit browser routing, not game simulation |
| `editor` | React authoring controls + projected viewport; separate preview wrapper consumes game-host |
| `exporter` | shared closure builder, metadata/scans/static artifact writer; bootstrap consumes game-host |

**Plan-review PR-5 repair — new units are a contract change.** `platformer-game`
and `game-host` are not yet in `dependencies.md` §2/§3/§4.1/§4.2/§4.3, and §2
(dependencies.md:72) makes adding a unit before its packet a contract change.
Gate K must therefore accept, per unit: the §2 row, the §3 public surface, the
§4.1/§4.2 import and bundle-graph edges, and the §4.3 forbidden edges. Two
explicit rules must be part of that acceptance:

- the editor **UI** (`packages/editor/src/ui/**`, `session/**`, `viewport/**`) may
  not import `game-host`; only the preview wrapper may, so the editor bundle keeps
  its DOM/Web Audio-free graph (§4.2's `editor/**` wildcard would otherwise permit
  it even though §4.1's exact direct-edge row does not);
- packets 58/60 must re-measure the export.md §5.4.1 fetch/graph counts that the
  new edges change, and request re-review if the measured text differs.

No new third-party runtime dependency is proposed. Keep current pins: Node 22
(host recorded 22.22.1), npm 9.2.0, TypeScript 5.9.3, three/@types 0.186.0,
esbuild 0.28.2, Vitest 5.0.1, ws 8.21.3, MCP SDK 1.30.0, React/types 19.3.0
(editor only), Rapier 2d-compat 0.20.0. These are recorded baseline versions, not
newly registry-verified in this task. Packet 38 checks version-sensitive browser,
three and Web Audio APIs against official docs and real probes. Browser automation,
new system libraries, a new three subpath or a pin change requires explicit review;
no automatic install. Manual desktop verification is acceptable.

## 5. Sequence and stop gates

| Gate | Packets | Evidence / stop condition |
|---|---|---|
| Plan review | these four planning documents | **ACCEPT WITH BOUNDED FOLLOW-UPS (2026-09-19)** — fresh read-only reviewer subsession + coordinator verification of every cited claim; three PR-1..PR-3 repairs applied in-document (`handoffs/m3-plan-review.md`); browser verification path recorded (§5.1); no implementation approval implied |
| K | 38–43 | Browser feasibility, exact contract diffs, version/error/limit tables, fixtures, ownership and authorability audit |
| L | 44–48 | Model/commands/migration/import/backend/MCP on real filesystem/processes, durability and old-project compatibility |
| M | 49–51 | Game flow, safe respawn and follow camera with real Rapier; committed-state/failure invariants |
| N | 52–55 | Shared presentation/input/audio/animation; real browser pixels, sound, activation, cleanup and controls |
| O | 56–60 | Visual/MCP authoring, shared production composition, isolated preview and standalone export; browser/network evidence |
| P | 61–62 | Authored sample and complete keyboard/gamepad playthroughs in editor/export, failure/recovery and final evidence review |

At K, record accept/reject per proposed diff. Then a separate **docs-only promotion**
applies accepted rows into `docs/contracts/` and records decisions in proposed
`docs/decisions/0003-m3-sample-game.md`; no production code or install in promotion.
Packets 44+ depend on promotion. Later contract changes reopen the affected K row
and dependent gates; measured scan follow-ups have the same discipline. A completed
handoff is not a review verdict. No automatic next-packet execution.

38 can report unavailable equipment and independent contract drafting can continue;
K cannot claim browser feasibility accepted without evidence or an explicit owner
scope disposition. N/O/P must retain required visual/audio/hardware evidence as
UNVERIFIED if unavailable. Owner disposition is recorded, never invented; changing
an acceptance target requires review rather than relabeling mocked results.

### 5.1 Recorded verification-path disposition (plan-review PR-6)

The plan’s “choose real desktop verification path” decision was answered by probe
evidence taken during the plan review, not by assumption:

| Capability | Container status (2026-09-19 probes) | Consequence for M3 |
|---|---|---|
| Real browser binary | **available** — Chrome for Testing 151.0.7922.34 (`headless=new`) from the pre-existing local Playwright cache, launched with the pre-existing hand-extracted library tree plus two locally compiled no-op avahi stubs. No root, no apt, **no system package installed or modified**. | 38 must materialize a reusable runner; 52–62 must prefer *executed* browser evidence over README procedures. |
| WebGL 2 + three 0.186.0 | **available (software)** — ANGLE/SwiftShader WebGL 2.0, real `readPixels`/`toDataURL` pixels, shadow map allocated, 5 draw calls/52 triangles in a probe scene. | Rendering/pixel claims can be **executed and labelled software-rasteriser**; hardware-GPU claims stay UNVERIFIED. |
| DOM / network / console | **available** — the production `dist/editor` bundle was loaded over HTTP and rendered (title, panels, 1 canvas, 21 buttons, real `/api/v1/sessions` requests observed). | HUD/DOM evidence and sanitized console/network records are obtainable in-container. |
| AudioContext + PCM decode | **partial** — `AudioContext` exists and `decodeAudioData` of a generated 48 kHz mono 16-bit WAV succeeds, but the context stays `suspended` after `resume()` (no audio device). | Decode/inspection/lifecycle rows are executable; **audible output (B13) is UNVERIFIED in-container**. |
| Physical gamepad, display, hardware GPU | **absent** — `navigator.getGamepads()` returns 0 devices, no `/dev/input`, `DISPLAY` unset, no Xvfb. | B15/B22 gamepad halves and hardware-GPU claims stay UNVERIFIED with owner manual procedures. |
| Composited page screenshot | **limited** — DOM composites into the page screenshot; WebGL canvas content does not (SwiftShader), while `canvas.toDataURL()` is correct. | Canvas evidence uses the in-page relay; HUD evidence uses a separate page screenshot, as acceptance §1 already requires. |

These probes are coordinator-run feasibility evidence; they are **not** M3
acceptance evidence and they do not close any M2 row. Packet 38 re-runs them under
its own evidence directory, cites the versions and records the unavailable
equipment in the same terms.

## 6. Carry-over and decisions for review

| Item | Disposition/checkpoint |
|---|---|
| M2 owner-reported completion vs repository UNVERIFIED evidence | 38 cites owner disposition and real artifacts, preserving M2 historical rows; M3 browser proof is required independently |
| Provisional physics/BR-2 and BR-3 secure-context/gamepad topology | 38 records device/browser/topology and real-library baseline; retain directional CPU labels; no re-selection absent a reproduced blocker |
| C35-5 authored settings | Mandatory 42/58 closure with non-default numeric Play/export test |
| M2 shared skeleton limitation | M3 animation profile explicitly rigid only; 41/53 reject skinned profile inputs; skeletal support remains separately deferred |
| Empty glTF extension allowlist | Keep empty; no extension added merely for sample art |
| Trusted-main-thread behaviors | Existing trust limitation unchanged; sample can use built-in modules only. Regression-test published behavior compatibility without weakening its guard or adding ambient APIs |
| Existing U-2 cold export issue not reproduced / U-3 process marker | 60 cold builds; 62 documented disposable restart. No speculative fix or relaxed ownership |
| M4 templates/performance/reliability | Not silently pulled forward. Basic load/resource diagnostics are evidence, not accepted product budgets |

Review decisions: accept/revise level scope and rigid animation/WAV profiles;
approve schema/storage v3 + manifest v2 direction; agree game-zone/reset/phase
ownership; approve shared host/package boundary; choose real desktop verification
path. Exact shapes/numbers belong to 39–43 and must be fixed before K, not left to
implementation agents. No decision requires pretending the current plan is an
accepted contract.

**Exact next step: architectural M3 plan review. Packet 38 only after recorded
plan acceptance and explicit execution authorization. M3 implementation not started.**
