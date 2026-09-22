# M3 task packets — 38–62

**DRAFT · 2026-09-19. Review [m3-plan.md](m3-plan.md) first. All packets pending.**
Sample: [m3-sample.md](m3-sample.md). Acceptance: [m3-acceptance.md](m3-acceptance.md).

## Rules for every packet

Read `AGENTS.md`, `docs/STATUS.md`, only the assigned packet, its prerequisite
handoffs and the named inputs. `contracts/`, `planning/`, `handoffs/`, `acceptance/`
and `decisions/` here are relative to `docs/`; other paths are repository-relative.
Contract shorthand `model` means `contracts/project-model.md`; other contract names
mean `contracts/<name>.md`. Public APIs mean `package.json` exports plus exported
entry/type declarations, not whole implementations. Read relevant source/tests
only after the public boundary. Preserve the uncommitted M2 tree.

Common reads: `planning/m3-plan.md` §§1–2/4–6, the relevant §3 brief,
`planning/m3-sample.md` relevant requirements, assigned acceptance rows,
`contracts/dependencies.md` §§3–5/7/9, and prerequisite handoffs. Contract packets
read existing sections they propose to replace; later packets read **promoted**
M3 contracts, not an unaccepted draft. If a required contract is absent, stop the
dependent work. Names below are provisional until Gate K.

Common permitted writes: `handoffs/<ID>.md`, that packet's STATUS progress row,
`acceptance/evidence-m3/<ID>/**`, plus the named scope. No adjacent product edits,
accepted-contract edits, dependency upgrades, user-project writes, deployment,
pushes or service restarts unless explicitly included. No product files in a
contract packet. Package registration/lockfile changes below mean only approved
workspace links and exact approved dependencies, never opportunistic normalization.

Each handoff contains outcome, changed files/scoped diff or actual commit ID,
commands/results, acceptance PASS/FAIL/UNVERIFIED, limitations, numbered contract
requests, and exact next packet/gate (do not start it). Each contract proposal
contains strict shapes, validation order, finite limits/defaults, errors/statuses,
canonical bytes, public exports, ownership/disposal, compatibility and negative
fixtures. No downstream agent invents a missing field or lifetime rule.

Implementation completion checks: targeted tests plus `npm test`,
`npm run typecheck`, `npm run check-deps`, `npm run check-boundaries`,
`npm run build`; old M1/M2 fixtures and trace checks must remain green. Add an
M3 fixture checker as part of the contract pack and run it thereafter. New edges
need disposable negative probes; remove probes afterwards. Evidence must include
real filesystem/subprocess/SDK/library/browser coverage where named, not mocks
alone. Never overwrite committed evidence in ordinary tests (explicit evidence
output directory). Gates repeat clean installation in a disposable copy.

Browser records name OS/device/browser/version, URL origins/secure context,
WebGL backend, viewport, physical input/audio devices, console/network and real
screenshots. An executable TypeScript file under `tests/browser/` is not proof
that a browser ran it. Missing hardware remains UNVERIFIED.

## Contract drafting and promotion

38–43 produce proposals under `planning/m3-contracts/` and fixtures/checkers under
`fixtures/m3/contracts/`. These are **future outputs**, not supplied by this plan.
Consolidate exact diffs in `planning/m3-contracts/contract-diffs.md`, including the
seven existing contracts and any new accepted `gameplay.md`/`presentation.md`
contract homes. Each row has one author, destination section, fixture, consumer,
version effect, and accept/reject status. Resolve superseded text explicitly.
Gate K review → bounded repair → explicit docs-only promotion → packet 44.
Promotion also records actual decisions in `decisions/0003-m3-sample-game.md`;
no inherited M2 pre-approval, no production code, no install. Review/promotions
have their own handoffs; they are not hidden parts of implementation packets.

**Plan-review PR-2 repair (packet sizing).** Packet 39 and packets 41/42 are
drafting-heavy. They keep their IDs and gates, but 39 is executed as **two bounded
parts with one handoff**: part 39-A owns the v3 data, version-combination,
migration and storage diffs; part 39-B owns the command/authoring surface, its
change/inverse data and the authorability table. Each part ends with its own
fixture group and a handoff section; a part that cannot finish inside its session
stops and records the exact remainder instead of widening scope. Packets 41 and 42
follow the same rule if their first part does not close the surface.

**Plan-review PR-5 repair (new units).** `platformer-game` and `game-host` do not
exist in `dependencies.md` §2/§3/§4.1/§4.2/§4.3, and §2 makes adding a unit before
its packet a contract change. Gate K must accept those rows explicitly (unit,
public surface, import edges, bundle-graph edges, forbidden edges) and must record
that the editor UI may not import `game-host` (only the preview wrapper may,
otherwise §4.2's `editor/**` wildcard would let DOM/Web Audio into the editor
bundle). Packets 49/54 create the units only after that acceptance.

## 38 — M3 browser baseline and bounded compatibility probes

- **Outcome:** a credible target/verification path for the complete game.
- **Dependency / gate:** plan review accepted + execution authorization / K.
- **Read:** decisions 0001/0002; `acceptance/m2-report.md` §§4/8;
  `handoffs/m2-owner-review.md`; runtime §§12–14, sessions §§13/17,
  export §§5/7; input and adapter public APIs; sample §5.
- **May edit:** `tests/evaluations/m3-browser/**`, evidence 38,
  `planning/m3-contracts/baseline.md`, decision 0003 as **proposed** only.
  Isolated probes, no package/lockfile or service changes.
- **Boundary:** exercise existing pinned production M2 bundles first; isolated
  Web Audio, rigid animation/crossfade, shadow and menu-input probes second.
  Consult official version-matched three docs/source and browser API docs; cite
  them and distinguish desk research from executed probes.
- **Failures:** missing browser/gamepad/audio, insecure context/iframe policy,
  autoplay denial, hidden-tab resume, WASM/CSP/GLB failure. Do not install browser
  tooling or system packages without separate approval.
- **Evidence:** named desktop, physical controller, local audio activation versus
  relayed input, basic rendered PNG and console/network. Record M2 sign-off/evidence
  disposition without fabricating historical closure. No benchmark promises.
  Materialize a **reusable real-browser runner** for later packets (launcher +
  CDP driver; the pinned `ws` may be used, no new dependency) and run at least one
  **existing production artifact** through it (e.g. the built editor bundle or an
  M2 export tree), capturing DOM text, a canvas PNG, console and network. Record
  the capability table honestly: software WebGL 2 only, audio decode but no audio
  device, gamepad API present with zero devices, no display. A README procedure is
  not evidence.
- **Accept / next:** supported path or explicit UNVERIFIED/blocking list with
  precise manual steps; reproducible probe sources. Next 39 (independent drafting
  allowed; unresolved feasibility blocks K-dependent approval).

## 39 — V3 game data, storage, migration and authoring contract

- **Outcome:** every required sample value is durable and authorable.
- **Dependency / gate:** 38 report / K.
- **Read:** model §§6/10–13/17–21; commands §§2–9; workspace §§4–9/13–15;
  model/commands/workspace public APIs; sample §§1–4.
- **May edit:** `planning/m3-contracts/{model,authoring,storage}.md`, owned
  model/commands/workspace section diffs, contract fixtures/checker groups.
- **Surface:** scene/storage v3, explicit legal version combinations and v2→v3
  copy migration; game config and entity reference rules; gameplay zones/spawns/
  camera/light/surface/animation-profile schema slots; model/audio discriminators.
  41 owns exact media fields. Specify create/set/remove/query, complete changes/
  inverses, retry/no-change/conflict ordering and prefab-copy/deletion semantics.
  **Additionally owns the three plan-review PR-1 values** (`m3-plan.md` §2.1): the
  bounded instructions string, the checkpoint zone's safe-spawn reference and the
  checkpoint activation-appearance slot. Each needs a creation path, not only an
  edit path. Name the document being versioned explicitly: authoring `project.json`
  keeps `schemaVersion` 1; the runtime-content `manifest.json` `manifestVersion`
  moves 1 → 2; add `manifest 1 + scene 3 + storage 3` to the project-model §6 and
  workspace §4.5 combination tables. Executed as parts 39-A/39-B (see the promotion
  section).
- **Failures:** unsupported versions, partial migration, invalid zone transforms,
  missing/multiple player/camera/start/goal, dangling checkpoints/assets, kind
  mismatch, deleting referenced markers, overflow, unsupported prefab capture.
- **Evidence:** byte-exact old/new/migrated envelopes plus valid/invalid command
  scenarios; UI/MCP authorability table including creation (not just editing).
  Fixed catalog/request/document limits and original-preserving migration outcomes.
- **Accept / next:** no field requires direct filesystem authoring, no second
  mutable document, no silent upgrade. Next 40.

## 40 — Game flow, trigger, respawn and camera contract

- **Outcome:** deterministic run rules with one physics/transform owner.
- **Dependency / gate:** 39 / K.
- **Read:** runtime §§3–6/12–14; model §21; public runtime types/ports,
  platformer/controller and physics adapter exports; proposed model; sample §§2–3.
- **May edit:** `planning/m3-contracts/gameplay.md`, runtime/model diffs owned by
  this packet, gameplay trace/reset/camera fixtures and checker groups.
- **Surface:** proposed `GameSessionPort`, committed `GameView`, bounded game
  events/observations, M3-only phase order, module reset lifecycle, restricted
  physics reset/clearance operations and camera-owner interface. Freeze all
  delays, overlap tolerances, event bounds, camera/dead-zone parameters and
  same-step precedence. Preserve old ActionFrame and M1/M2 schedule semantics.
- **Failures:** overlap ties, touching/fast sweep/teleport, repeated triggers,
  obstructed spawn, held input, reset during failure, partial reset/private-world
  failure, stale event, camera bounds smaller than frustum, nonfinite resize.
- **Evidence:** state-transition and numeric fixtures derived independently;
  last-committed-state assertions for every failure phase. Prove proposed reset
  covers velocity/windows/physics/prev+curr/input/trigger/camera coherently.
- **Accept / next:** no gameplay call to the current diagnostic-only reset, no
  double writer, no rollback fiction. Next 41.

## 41 — Bounded rendering, animation and audio contract

- **Outcome:** exact presentation data/lifetimes without a general graphics system.
- **Dependency / gate:** 39–40 and 38 probe evidence / K.
- **Read:** model §§10/18–20, runtime §§6/8/12; adapter visual/preview exports;
  asset-pipeline exports; proposed model/gameplay; sample §4.
- **May edit:** `planning/m3-contracts/presentation.md`, owned model/runtime/
  commands diffs, GLB/WAV/light/material/animation fixtures and checker groups.
- **Surface:** one key/fill/shadow profile; copied primitive presets; rigid-node
  animation role selector and bounded crossfade; digest/version-bound clip role
  metadata and atomic reimport validation; PCM-WAV inspector/recipe; injected
  browser audio interface. Explicitly replace §18.1's no-persisted-subresources
  rule only for the reviewed version-local mapping. Exact budgets/limits here
  are resource bounds, not performance promises. Owns the plan-review PR-1
  checkpoint activation-appearance data and the read-only view bit the adapter
  consumes (`m3-plan.md` §2.1); session HUD text alone does not satisfy it.
- **Failures:** missing/reordered/duplicate roles, animated holder/root motion,
  skins in profile, one instance affecting another, invalid WAV/chunks/length/
  format, corrupt bytes, voice flood, late decode after stop, autoplay blocked,
  shadow unavailable and repeated disposal.
- **Evidence:** benign self-generated licensed fixtures, version-bound reimport/
  undo cases, load/dispose ownership table; browser probe outcomes, no fake audio.
- **Accept / next:** defaults/caps/errors fixed; silent gameplay fallback is
  distinguished from corrupt required content; no extension/pin added. Next 42.

## 42 — Game host, controls, immutable delivery and dependency contract

- **Outcome:** one host/composition and a complete secure output closure.
- **Dependency / gate:** 39–41 / K.
- **Read:** runtime §3.1 C35-5/§14, sessions §§7/10–13/16–19, export §§2–7,
  dependencies §§3–6/9; input/protocol/exporter public exports; existing
  `export-composition.ts` and preview registration seam (selective inspection).
- **May edit:** `planning/m3-contracts/delivery.md`, owned sessions/export/
  dependencies/runtime diffs and wire/manifest/closure fixtures/checker groups.
- **Surface:** manifest v2 with settings/game/media identity; shared public
  `game-host` composition entry and package edges; frame/menu control separation,
  start/replay/mute and typed observation relay/SDK tool; bounded run identity,
  stale/timeout/disconnect semantics; bridge versioning, audio/CSP/MIME and static
  path closure. 48 may expose unsupported consumers honestly until 59. At K this
  packet must also propose the exact `dependencies.md` §2/§3/§4.1/§4.2/§4.3 rows
  for `platformer-game` and `game-host`, plus the rule that the editor UI may not
  import `game-host` and that 58/60 re-measure the changed §5.4.1 counts.
- **Failures:** controls while no physics tick, held Start→jump, gamepad takeover,
  physical/injected race, postMessage mistaken for user activation, no browser,
  wrong origin/source/nonce, stale run, undeclared resource, timestamp identity,
  missing cue/role/settings, partial load/build and previous-output preservation.
- **Evidence:** exact request/result fixtures, hash preimages and independent
  digest check, package/entry graph and narrow scan exception proposals; captured
  settings reach both controller and physics configuration. Canvas screenshot
  versus DOM HUD evidence distinction explicit.
- **Accept / next:** no internal exporter import, duplicate bootstrap gameplay,
  credential leak or generic eval interface. Next 43.

## 43 — Contract pack integration and fixture audit

- **Outcome:** a reviewable, internally consistent Gate K pack.
- **Dependency / gate:** 38–42 / K (stop).
- **Read:** proposals/diffs and exported API inventories from 39–42; acceptance
  rows B01–B24; only destination contract sections needed to check collisions.
- **May edit:** `planning/m3-contracts/contract-diffs.md`, proposals to reconcile
  collisions, `fixtures/m3/contracts/**`, decision 0003 **draft**, planning
  acceptance details where K fixes previously proposed constants (never weaken
  requirements to hide failures).
- **Boundary:** no product code, no accepted contract edits. Give every field,
  op, error, phase, module and artifact exactly one owner and consumer. Resolve
  schema/manifest/bridge/API versions and obsolete M2 non-goal text explicitly.
  The feature→command→UI/MCP→runtime→export→acceptance matrix must prove a
  **creation** path for every `m3-plan.md` §2.1 value (instructions string,
  checkpoint safe-spawn reference, checkpoint activation appearance) and every
  authorability-table row; creation, not only editability, is the acceptance bar.
- **Failures:** uncreatable entity, query missing a control's data, media kind
  treated as GLB, build identity missing settings, reset with two owners,
  package edge absent, fixture silently coercing an invalid input.
- **Evidence:** executable fixture checker with deliberate corruption negative
  control; independent digest/geometry derivations; feature→command→UI/MCP→
  runtime→export→acceptance matrix. Record incomplete browser feasibility honestly.
- **Accept / next:** all diff rows and owner decisions ready, not approved.
  **Next Gate K review, repairs and docs-only promotion; then 44.**

## 44 — V3 model validation and pure migration

- **Outcome:** strict v3 model support without changing v1/v2 meaning.
- **Dependency / gate:** K accepted + docs-only promotion / L.
- **Read:** promoted model/storage portions; model public API; contract fixtures.
- **May edit:** `packages/project-model/**`, `fixtures/m3/model/**`.
- **Scope note (plan-review PR-2):** this packet owns `packages/project-model/**`
  authority through Gate L. A later packet (58) also edits manifest derivation;
  that edit **must be declared here at K** and reopens the affected project-model
  section as a bounded re-review before Gate O acceptance — it is not a silent
  post-gate write. The same discipline applies to any later edit of a
  Gate-L-owned package.
- **Surface:** versioned parse/validate/normalize/capture helpers and pure v2→v3
  conversion, including role/cue/settings references and finite bounds.
- **Failures/evidence:** run every positive/negative/version fixture; unknown
  fields/kinds fail non-destructively; canonical byte/digest roundtrip; migration
  preserves source/IDs and agrees with the identity policy; old fixtures unchanged.
- **Accept / next:** no renderer, commands, transport or filesystem logic. B01,
  model half B02/B03/B12/B14/B17. Next 45.

## 45 — Pure game and presentation commands

- **Outcome:** complete typed edits for all v3 data on the existing history engine.
- **Dependency / gate:** 44 / L.
- **Read:** promoted commands; model exports; packet-39 scenarios; existing command
  request/apply/inverse public APIs.
- **May edit:** `packages/commands/**`, `fixtures/m3/commands/**`.
- **Surface:** approved create/component/config/media-publication/query operations;
  changes/inverses, whole-project validation and bounded summaries. No I/O.
- **Failures/evidence:** creation/add/edit/remove, illegal deletion/reference,
  invalid reimport role/kind, no-change, immutable inputs, exact inverse and redo
  IDs, stale requests, failed atomic edit, mixed UI/MCP history; copied presets
  and independent prefab copies. Replay contract scenarios byte-exactly.
- **Accept / next:** every sample authoring-table row has an executable pure path;
  no unavailable feature disguised as success. B02/B03/B17/B18. Next 46.

## 46 — Durable v3 workspace and migration-copy

- **Outcome:** durable v3 state and original-preserving migration on real files.
- **Dependency / gate:** 45 / L.
- **Read:** promoted workspace/model versions; workspace public service; accepted
  durability/ownership rules; packet-39 crash/migration fixtures.
- **May edit:** `packages/workspace/**`, `fixtures/m3/storage/**`,
  `tests/crash/m3-*`, `tests/integration/m3-storage/**`.
- **Surface:** versioned envelope loader/executor, approved copy-migration operator,
  typed prepared-media facts and immutable byte reads (inspector injected later).
- **Failures/evidence:** real SIGKILL before/after envelope replacement and copy
  marker stages, stale owner, interrupted destination, disk/write failure, lost
  ack/replay after restart, source tamper/missing blob, unsupported old/new mix.
  Source tree byte-identical after both successful and refused migration.
- **Accept / next:** no second catalog/mutation path, durable ack ordering unchanged;
  old projects still open/edit/export under original version. B01/B18. Next 47.

## 47 — WAV and version-bound animation import inspection

- **Outcome:** bounded pure media inspection, not browser decoding or publication.
- **Dependency / gate:** 46 / L.
- **Read:** promoted presentation/model import profile; asset-pipeline/model public
  APIs; accepted media fixtures from 41.
- **May edit:** `packages/asset-pipeline/**`, `fixtures/m3/media/**`,
  `tests/integration/m3-media-inspect/**`.
- **Surface:** approved `inspectAudio`/role-aware GLB proposal and recipe/metadata
  digests over supplied bytes; names finalized at K. No new third-party package.
- **Failures/evidence:** corrupt/truncated/duplicate/oversized RIFF chunks,
  unsupported PCM format, kind/MIME mismatch, role reorder/missing clip/skin/root
  motion, decoded caps, cancellation, no-network/no-filesystem probes. Independently
  recompute digests of every committed fixture and recipe.
- **Accept / next:** accepted bytes produce immutable typed proposals; rejection
  has exact bounded diagnostics; no source execution or state write. B12/B14. Next 48.

## 48 — Content/API/projection/MCP v3 parity

- **Outcome:** real backend and SDK access to durable v3 edits/imports.
- **Dependency / gate:** 47 / L (stop).
- **Read:** promoted commands/sessions/delivery; workspace/pipeline/protocol/service
  public APIs; packet-42 relay/manifest fixtures.
- **May edit:** `packages/{protocol,backend,mcp-adapter}/**`, workspace inspector
  injection seam only, `tests/integration/m3-content/**`.
- **Scope note (plan-review PR-2):** this packet owns `packages/protocol/**`
  authority through Gate L. Packet 59's bridge/relay work that touches `protocol`
  **must be declared here at K** and reopens only the named protocol sections as a
  bounded re-review before Gate O acceptance.
- **Surface:** versioned wire validators/full-state/change/query, upload-inspect-
  publish media via workspace, copy-migration operator route, bounded game-control/
  observation relay and real SDK tool. No game simulation in backend. Until 59,
  absent browser capability returns the contracted unsupported/unavailable error.
- **Failures/evidence:** real fs + backend process + WS + stdio MCP SDK: import/
  retry/query/config/edit/undo, two-client stale edit and convergence; unauthorized/
  traversal/cross-project/oversized upload, corrupt audio, stale jobs, blob-before-
  envelope ordering, no-browser/wrong-session control, relay timeout and bounded logs.
- **Accept / next:** UI/MCP envelopes use one executor; binary-free state frames;
  B02/B03/B12/B17/B18/B20 transport scope. **Next Gate L review; then 49.**

## 49 — Committed game flow and swept gameplay zones

- **Outcome:** a deterministic run state with real controller motion.
- **Dependency / gate:** L accepted / M.
- **Read:** promoted gameplay/runtime schedule; runtime/platformer APIs; 40 traces.
- **May edit:** `packages/runtime/**`, new `packages/platformer-game/**`,
  `fixtures/m3/gameplay/**`, `tests/m3-gameplay/**`; approved workspace link and
  boundary table/test registration only.
- **Surface:** M3 phase/commit plumbing and pure `platformer-game` session/zone
  module; bounded event/read-only view, awaitingStart/playing/respawning/won and
  queued reset request (the reset consumer is 50). Use a real Rapier course in
  tests; do not claim completed respawn until 50.
- **Failures/evidence:** sweep/boundary/tie/teleport fixtures, fall threshold,
  single activation, repeated overlap, no phantom step after stall, no progression
  before Start/after Win, fail-stop retaining last complete gameplay view. Compare
  independent trace derivation; all M1/M2 traces unchanged. Negative package edges.
- **Accept / next:** B04/B05/B06/B08 logic; no DOM, renderer or second movement
  solver. Next 50.

## 50 — Runtime-owned safe respawn

- **Outcome:** death actually recovers at the right safe spawn without authoring edits.
- **Dependency / gate:** 49 / M.
- **Read:** promoted reset lifecycle/port contract; runtime/platformer/physics
  exports; 40 reset failure fixtures and 49 queued-reset public surface.
- **May edit:** runtime reset barrier, platformer reset seam, physics-rapier
  reset/clearance seam, platformer-game reset integration only;
  `fixtures/m3/respawn/**`, `tests/m3-respawn/**`.
- **Surface:** exactly the accepted reset transaction; no general teleport API or
  raw physics handle for game code.
- **Failures/evidence:** real Rapier death-before/after-checkpoint, nonzero velocity,
  buffered/held jump, pending control intent, repeated deaths, blocked destination,
  stop during delay and injected failure at each reset phase. Assert physics pose,
  velocity/windows, trigger latches and prev/curr coherence; render never sweeps
  between death and spawn; failed runtime cannot resume. Snapshot unchanged.
- **Accept / next:** B06/B07/B09; no reset performed by HUD/editor/script. Next 51.

## 51 — Follow camera with one transform owner

- **Outcome:** player remains framed across traversal and respawn.
- **Dependency / gate:** 50 / M (stop).
- **Read:** promoted camera/gameplay and runtime interpolation/ownership; adapter
  camera consumption API; 40 numeric fixtures.
- **May edit:** `packages/platformer-game/**` camera module; runtime camera/resize
  port seam expressly approved at K; `fixtures/m3/camera/**`, `tests/m3-camera/**`.
- **Surface:** pure fixed-step follow/dead-zone/bounds math, single camera owner,
  read-only projection parameters and reset snap; no renderer navigation changes.
- **Failures/evidence:** level-edge clamps, narrow/large aspect, short bounds,
  player fall, sudden respawn, resize, nonfinite dimensions and conflicting camera
  owner. Numeric fixture equality and real runtime/physics trace; available browser
  probe records actual framing, otherwise pixel portion remains UNVERIFIED.
- **Accept / next:** B10; no second frame driver or feedback into player physics.
  **Next Gate M review; then 52.**

## 52 — Shared light, shadow and primitive-material rendering

- **Outcome:** the same authored v3 rendering in viewport, preview and export.
- **Dependency / gate:** M accepted / N.
- **Read:** promoted presentation/model and adapter lifetime contract; adapter
  public realization API; 38 supported capability report.
- **May edit:** `packages/three-adapter/**`, `tests/browser/m3-render/**`,
  `fixtures/m3/render/**`; only K-approved boundary entries if required.
- **Surface:** bounded directional/ambient lighting, primitive surface presets
  expanded as data, shadow capability/diagnostics. M1/M2 paths unchanged.
- **Failures/evidence:** light/surface validation, unsupported shadows fallback,
  resize/context-loss, repeated create/dispose and changing one material instance
  only. Real WebGL screenshots and console/resource counters on target browser;
  no GPU-memory claim from JS object counts.
- **Accept / next:** B11, no new pipeline/shader graph/pin. Next 53.

## 53 — Rigid runtime animation roles and blending

- **Outcome:** independent animated model instances driven by committed game state.
- **Dependency / gate:** 52 / N.
- **Read:** promoted presentation role/reimport rules; adapter resource APIs;
  platformer-game read-only view; model/version fixtures.
- **May edit:** `packages/three-adapter/**`, presentation-selector portion of
  `packages/platformer-game/**`, `tests/browser/m3-animation/**`, animation fixtures.
- **Surface:** approved visual role/crossfade controller on the shared GLB resource
  owner. One host-driven update, no clock/global loop or physics transform writes.
- **Failures/evidence:** independent pose/mixer per copy, idle/run/airborne switch,
  blend duration, clip reorder with new mapping, missing role refusal, stale load,
  root-motion/skin profile rejection, disposal while blending; real-loader tests
  plus browser rendered poses. Never claim skeletal isolation.
- **Accept / next:** B14; authored bytes stay pinned during active play. Next 54.

## 54 — Browser audio resource owner

- **Outcome:** bounded short cues with honest activation and sound-off behavior.
- **Dependency / gate:** 53 / N.
- **Read:** promoted presentation/audio and delivery interfaces; gameplay event
  public types; 38 activation results; official Web Audio API docs.
- **May edit:** new `packages/game-host/**` audio entry only,
  `tests/browser/m3-audio/**`; approved workspace link/exports/dependencies and
  boundary checker/table/tests only (no stubs for later host parts).
- **Surface:** bytes-in audio owner, local activation, deduplicated committed cues,
  mute/status, bounded voices, suspend/dispose. DOM/window access isolated to this
  browser entry; pure runtime never constructs an AudioContext.
- **Failures/evidence:** rejected resume, absent AudioContext, malformed decode,
  suspended device, flood/voice cap, late decode/cue from old run, mute/unmute,
  hide/stop/dispose before initialization. Real audible jump/checkpoint/death/win
  evidence and sound-off completion; counters alone do not prove audible output.
- **Accept / next:** B12/B13 resource/activation scope; no remote/audio fetch in
  owner, no new npm audio library. Next 55.

## 55 — Start/completion HUD and single-owner game controls

- **Outcome:** a complete keyboard/gamepad-operable game shell.
- **Dependency / gate:** 54 / N (stop).
- **Read:** promoted host/control/input/observation contract; input/gameplay/audio
  public APIs; sample §2; existing focus/visibility handling.
- **May edit:** `packages/game-host/**` HUD/control entries,
  `packages/input/**` approved menu-control seam, `tests/browser/m3-shell/**`;
  approved public exports/edges only.
- **Surface:** Start, completion, replay, objective/checkpoint/deaths and mute;
  separate bounded semantic game-control channel; plain DOM/text/buttons, no React
  outside editor. Injected observations and lifecycle actions, no gameplay math.
  Renders the authored instructions string as a text node (never project-supplied
  HTML) and the HUD checkpoint state; it owns no checkpoint-activation appearance
  (41/52).
- **Failures/evidence:** title/win when no simulation tick, held confirm→jump,
  editable-field/focus suppression, gamepad takeover/disconnect, stale run request,
  exclusive injected mode, hidden-tab resume, malicious title text, repeated attach/
  detach. Real keyboard and physical pad start→win-shell→replay; local click unlock
  versus synthetic relay denial; DOM screenshot distinct from canvas screenshot.
- **Accept / next:** B04/B08/B09/B13/B15. **Next Gate N review; then 56.**

## 56 — Gameplay and camera authoring controls

- **Outcome:** user can create/edit the complete gameplay layout without raw JSON.
- **Dependency / gate:** N accepted / O.
- **Read:** promoted commands/sessions/gameplay; editor projection/client public
  surfaces; packet-39 authorability table; 48 wire APIs.
- **May edit:** `packages/editor/**` gameplay/config/camera panels, projection,
  client and imperative zone gizmo/overlay only; `tests/browser/m3-authoring/**`.
- **Surface:** create/add/remove/configure zones/spawns/camera follow; typed player/
  checkpoint/goal references and game config; bounded six-key settings controls.
  Backend projection authoritative; local zone handles use zero commands during
  gesture, one on release, none on cancel; one undo.
- **Failures/evidence:** invalid references/coordinates, duplicate roles, illegal
  delete, stale MCP edit during gesture, disconnect/resync and lost-ack retry.
  Real backend browser authoring + SDK edit converge; error is visible and failed
  edits preserve state; reopen retains authored game configuration.
- **Accept / next:** B02/B03/B17 gameplay UI scope; no filesystem edits. Next 57.

## 57 — Media, lighting and animation authoring controls

- **Outcome:** sample presentation is editable through supported commands.
- **Dependency / gate:** 56 / O.
- **Read:** promoted presentation/commands/content services; adapter preview and
  editor content-projection APIs; 48 media routes and 53 role fixtures.
- **May edit:** `packages/editor/**` media/light/surface/role controls and
  imperative viewport integration only; `tests/browser/m3-media-authoring/**`.
- **Surface:** WAV import/inspection/cue assignment, model-version role mapping/
  reimport, key/fill/shadow controls, apply copied primitive preset. Preview audio
  uses explicit local gesture and injected owner, no authoring token in resources.
- **Failures/evidence:** invalid drop/role/kind, autoplay block, stale import job,
  reimport refusal preserves old version, undo/redo mapping and bytes, independent
  prefab copies and material edits, cancelled preview disposal. Actual browser
  import/edit/reopen/MCP convergence and WebGL/audio evidence.
- **Accept / next:** B11/B12/B14/B17; shared render realization, not a new scene
  mutation path or linked-preset system. Next 58.

## 58 — Immutable M3 closure, settings and shared composition

- **Outcome:** one captured input and one production composition for both hosts.
- **Dependency / gate:** 57 / O.
- **Read:** promoted manifest v2/delivery/dependency/runtime settings contract;
  model/workspace/exporter/game-host exports; old production composition seam.
- **May edit:** model manifest derivation, `packages/exporter/**` shared closure
  builder, `packages/game-host/**` public composition entry, workspace captured-
  view seam only if named at K; `tests/integration/m3-builds/**`; approved exports/
  edges/build checks and workspace dependency declarations only.
- **Reopened section (plan-review PR-2):** the model manifest-derivation edit
  reopens the named project-model section owned by packet 44 (Gate L). Record the
  reopened row and its bounded re-review in this packet's handoff before Gate O
  acceptance; do not treat it as an unreviewed post-gate write.
- **New-unit edges:** importing `game-host` here requires the Gate-K-accepted
  `dependencies.md` §2/§3/§4 rows for `platformer-game` and `game-host`; the
  editor UI must not import `game-host` (preview wrapper only).
- **Surface:** manifest v2 capture/identity/closure; resolve game data, roles,
  audio and non-default settings from one envelope; reuse existing module wiring
  through public composition, preserving old entry behavior. No new renderer,
  controller, compiler or gameplay implementation.
- **Failures/evidence:** missing/corrupt/kind-mismatched blob, mixed revision,
  missing role, unknown module/API, nondefault settings absent from hash or one
  adapter, cancelled build; cold processes and independent digest re-derivation.
  Production composition numeric trace proves settings reach physics + controller.
  Bundle graph negative probes; remeasure any exact scan row and request review
  before adopting changed exceptions.
- **Accept / next:** B16/B19/B21 build scope; no editor-internal/exporter-internal
  cross import. Next 59.

## 59 — Isolated M3 Play, control and observation integration

- **Outcome:** editor Play runs the actual game host from immutable artifacts.
- **Dependency / gate:** 58 / O.
- **Read:** promoted sessions/bridge/load/relay contract; protocol/game-host public
  exports; backend locator APIs; 55 control consumer and 58 closure.
- **May edit:** editor preview wrapper/bridge and Play status UI, backend play/
  locator/relay integration, protocol refinements only within accepted schemas,
  `tests/integration/m3-play/**`, `tests/browser/m3-play/**`.
- **Reopened section (plan-review PR-2):** a protocol refinement that changes an
  accepted schema reopens the named protocol section owned by packet 48 (Gate L)
  and needs the bounded re-review recorded in this handoff before Gate O
  acceptance.
- **Surface:** preview injects verified resources/ports into shared host; truthful
  ready means title screen loaded, not gameplay started. Selected-session game
  controls/observations and canvas screenshot carry current identities.
- **Failures/evidence:** real backend + browser + SDK, wrong origin/source/nonce,
  expired locator/late decode, no browser, stale run, control before ready, stop
  during load/respawn, tab hide, ten start/stop cycles. Capture Play, edit content
  live, verify old pin then fresh start adopts new build; no authoring writes.
  Capture actual rendered PNG plus separate DOM HUD evidence and redacted network.
- **Accept / next:** B04–B16 integrated preview scope, B19/B20; no fake browser
  acknowledgements establish visual success. Next 60.

## 60 — Standalone M3 export and production parity

- **Outcome:** full game runs from static output without any editor services.
- **Dependency / gate:** 59 / O (stop).
- **Read:** promoted export/delivery/dependencies; exporter and game-host exports;
  acceptance B19–B23; packet-58 manifest/scan evidence.
- **May edit:** `packages/exporter/**` export writer/bootstrap/scans/metadata,
  build/boundary tools only approved rows, `tests/integration/m3-export/**`,
  `tests/browser/m3-export/**`.
- **Surface:** same closure builder and public host as preview; complete relative
  HTML/CSS/media/behavior/engine output, exact licenses/version hashes, versioned
  metadata. No alternate sample logic in generated HTML.
- **Failures/evidence:** cold deployed-process builds, missing/corrupt media and
  rejected hostile source preserve old output; declared==emitted closure; negative
  authoring-token/capability/Node/URL scans. Export twice into **different trees**,
  hash before any overwrite, normalize only accepted timestamps/rederive buildId.
  Independent static server under non-root prefix, backend stopped/unreachable,
  actual browser keyboard/gamepad/audio play and recorded network. Replay same
  semantic trace through actual production preview/export composition, not a
  test-only controller; compare identities/events and contracted numeric tolerance.
- **Accept / next:** B19/B21/B22/B23. **Next Gate O review; then 61.**

## 61 — Author Beacon Reach through supported workflows

- **Outcome:** one complete, redistributable authored sample, not an engine feature.
- **Dependency / gate:** O accepted / P.
- **Read:** `planning/m3-sample.md`, `planning/m3-acceptance.md`; accepted authoring
  and media interfaces; handoffs 56–60. No general repository ingestion.
- **May edit:** `samples/beacon-reach/**` (sources/recipes/licenses/command recipe/
  captured authored project, not derived caches), `tests/integration/m3-sample/**`,
  browser playthrough procedures. Create sample only in a disposable workspace via
  public operator/commands/upload APIs; no direct active-envelope editing.
- **Surface:** sample imports approved GLBs/WAVs, creates independent decoration
  prefab copies, configures player/zones/camera/render/game data, saves/reopens.
  No engine source edits; discovered defects become scoped repair requests.
- **Failures/evidence:** generated asset provenance/digests, recipe reproducibility,
  all placement/reference IDs queryable, supported UI creation/editing, MCP stale
  edit, reimport/undo, clean source-backup restore in a new disposable project.
  Freeze traversable layout and step traces using actual physics and browser
  keyboard/pad; contract/sample tuning never silently changes accepted controller
  constants or shrinks failure coverage. Capture title/checkpoint/death/goal frames.
- **Accept / next:** B02/B03/B17/B24 plus complete B04–B15 sample experience;
  no hardcoded runtime entity IDs or sample-only bootstrap branches. Next 62.

## 62 — Integrated M3 acceptance and owner playthrough

- **Outcome:** honest complete milestone evidence and bounded deployment updates.
- **Dependency / gate:** 61 / P (stop).
- **Read:** acceptance B01–B24 and journey, sample brief, environment/deployment
  docs, handoffs 38/48/50/55/58–61. Inspect source selectively on failures.
- **May edit:** `acceptance/m3-report.md`, `acceptance/evidence-m3/62/**`,
  M3 additions to `acceptance/deployment.md`, handoff/STATUS row 62. Product fixes
  require separate scoped repairs; no opportunistic source or contract edits.
- **Boundary:** real deployed artifacts, disposable workspace/export roots, real
  browser, physical keyboard/controller and audio output. No installation on the
  owner's host or stopping non-disposable services without separate authorization.
- **Evidence:** full journey and row-level PASS/FAIL/UNVERIFIED; clean `npm ci`
  copy + full toolchain, actual versions/graphs/hashes, two-host playthroughs,
  screenshots/video or witnessed sound record, console/network, capture identity,
  no-source-mutation, disposal, migration/retry and settings/reimport parity.
  Separate measured process results from browser/hardware claims.
- **Accept / next:** required rows executed with no unresolved failures; missing
  browser/sound/gamepad evidence keeps milestone acceptance incomplete. Bring raw
  evidence for **Gate P review**; record owner acceptance only if actually given.
  Then stop. **M4 planning only on a separate owner request; never auto-start it.**
