# M2 task packets — 14–37

**DRAFT: first review m2-plan.md. No packet is started by this document.**
Baseline is accepted M1 (`5b746ee`); all M2 packets are pending.

## Instructions applying to every packet

Read `AGENTS.md`, `docs/STATUS.md`, **only the assigned section below**, and the
named read set. `contracts/`, `planning/`, `decisions/`, `handoffs/`, `acceptance/`
below are relative to `docs/`; `packages/`, `fixtures/`, `tests/`, `tools/` are
repository-relative. An earlier handoff is evidence/context, not a substitute
for an accepted contract. Read public exports before implementation internals.
Contract shorthand below resolves to `docs/contracts/<name>.md`; `model` means
`project-model.md`. Public package APIs mean their `package.json` exports map and
its exported entry/type declarations, not the whole package implementation.

Common read set: `planning/m2-plan.md` §§1–2 and the brief relevant to this packet;
`planning/m2-acceptance.md` rows owned by this packet; accepted
`contracts/dependencies.md`; prerequisite handoff(s). New contract names below are
**planned outputs**, not files that already exist. Stop if a required accepted
contract is missing.

Common allowed edits: `handoffs/<ID>.md`, that packet's progress row in
`docs/STATUS.md`, tests/fixtures within its named scope. Package registration,
lockfile/build/boundary-table changes are allowed **only where expressly named**
and exactly as Gate E approves. Never disable checks to accommodate a new edge.
No unlisted package edits, user projects, deployment, pushes or harness changes.
If an adjacent API is insufficient, report a contract/change request; do safe
independent work, then stop the dependent portion.

Every handoff: outcome, scoped diff/actual commit ID, commands/results, criteria
passed/failed/unverified, limitations, contract requests, **exact next packet or
gate**. Do not start it. Browser evidence records OS/browser/version, WebGL backend,
URL topology, dimensions, input hardware where relevant, console/network and real
screenshots. Mocks establish unit behavior, not browser, persistence or SDK success.

For implementation packets run affected tests and root `npm test`,
`npm run typecheck`, `npm run check-deps`, `npm run check-boundaries`,
`npm run build` at completion; record unavailable checks, never invent green output.
Use the lockfile and existing pins. Add a negative boundary probe when introducing
a package/edge; remove disposable probes. Verify clean installation at the gates.

### Contract drafting and promotion

Packets 15–19 write **proposed** new contracts and exact section-level diffs under
`planning/m2-contracts/`, with fixtures under `fixtures/m2/contracts/`.
They do not silently overwrite M1 contracts. A proposal must define strict shapes,
validation order, defaults/limits, errors, ownership/disposal, public exports,
compatibility and observable failure outcomes; illustrative prose alone is not done.
At Gate E the reviewer records accept/reject per diff. An explicit docs-only
promotion step applies only accepted diffs into `contracts/` and records owner
pin/trust decisions in `decisions/0002-m2-content-and-behavior.md` before packet 20.
No code or dependency installation occurs in promotion. Packet 19 maintains the
consolidated diff inventory so later packets need not read every proposal.

## 14 — Browser baseline and bounded physics selection

- **Outcome:** an evidence-backed physics/distribution recommendation and a usable
  M2 browser/gamepad verification path; no engine features.
- **Depends on:** plan review recorded accepted. **Gate:** E.
- **Read:** `architecture/charter.md` §§6/8/9; decision 0001 §§3/6/7;
  `contracts/runtime.md`; `contracts/export.md` §§5/7;
  `acceptance/m1-report.md` §§5–6; `planning/m2-physics.md`;
  runtime public types and existing build options.
- **May edit:** `decisions/0002-m2-content-and-behavior.md` (proposed until approved),
  `planning/m2-physics.md`, `tests/evaluations/m2-physics/**` (standalone probes),
  `acceptance/evidence-m2/14/**` (sanitized results).
- **Public boundary:** evaluate injected `PhysicsWorld`/character-movement port,
  no production package. Candidate installs, if needed, use a disposable isolated
  prefix with exact recorded versions/integrities, not the repo lockfile.
- **Work/evidence:** compare Rapier 2D, Rapier 3D, Planck and cannon-es against the
  same static-course requirements. Build/init/dispose the recommended candidate
  using the adopted esbuild/TS/browser setup, including cold init and standalone
  subpath serving; test ramps, grounding, wall/head collisions. Record distribution
  bytes, initialization, p50/p95/p99 CPU fixed-step cost, fixture body counts,
  warmup/sample count, machine/browser and profiler limits. No GPU timing claims.
  Desk-research eliminations are labeled, not fake benchmark comparisons.
- **Failure cases:** WASM/CSP/init failure, unavailable gamepad/secure context,
  package license/version incompatibility and missing browser. Missing real
  evidence leaves selection provisional and blocks dependent approval.
- **Acceptance:** exact recommended pin/license and alternatives/tradeoffs documented;
  reference browser can render M1 and expose a physical gamepad in the intended
  separate-origin topology. Manual desktop evidence is acceptable; installing
  system packages/services or browser tooling requires separate authorization.
- **Next:** 15 (selection-dependent parts remain blocked if evidence is absent).

## 15 — Content storage, asset identities and migration contract

- **Outcome:** a complete asset/content persistence contract, not an importer.
- **Depends on:** 14 report. **Gate:** E.
- **Read:** `contracts/project-model.md` §§3–6/10/12–14/17;
  `contracts/workspace.md` §§3–9/11; `contracts/commands.md` §§6–7/9;
  model/workspace public types; plan §§3.1–3.2.
- **May edit:** `planning/m2-contracts/{assets,content-storage}.md`, proposed diffs
  for `project-model.md` and `workspace.md`, contract fixtures.
- **Public surface:** proposed `ContentCatalog`, `AssetRecord`, `ImportProposal`,
  captured immutable content view and workspace stage/publish/read-blob operations.
  Resolve asset IDs separately from content/recipe hashes. Define all byte, decoded
  resource, catalog, staging, job, frame and quota bounds.
- **Failures:** traversal/symlinks, malformed GLB, remote references, missing blobs,
  stale/abandoned job, ownership loss, crash at each publication boundary, full disk,
  corrupted cache/source, v1/v2 mismatch and interrupted migration-copy creation.
- **Acceptance:** byte-exact valid/invalid envelopes and migration examples; failure
  matrix proves one authoritative commit and retry replay before stage lookup;
  reimport/undo retain old bytes; no GC can invalidate play/history; explicit
  version compatibility and original-preserving migration/recovery procedure.
  Specify artifact backup classification and external-source tamper handling.
- **Next:** 16.

## 16 — Typed edits, prefab and property contracts

- **Outcome:** exact command/query/history/projection semantics for M2 content.
- **Depends on:** 15 draft. **Gate:** E.
- **Read:** `contracts/commands.md`; model/command public types;
  packet-15 proposals; plan §3.3.
- **May edit:** `planning/m2-contracts/{prefabs,properties}.md`, proposed
  `commands.md`/`project-model.md` diffs, contract fixtures.
- **Public surface:** typed asset/behavior publication, component/property/settings
  edits, prefab creation/instantiation; bounded asset/prefab/behavior queries;
  change/inverse shapes and deterministic entity-ID allocation.
- **Failures:** duplicate IDs, remapped internal refs, forbidden external refs,
  nested prefabs/camera capture, unknown properties, incompatible declaration
  update, no-change, stale/reused requests, payload/entity/depth limits.
- **Acceptance:** fixtures show two independent instances, allowed initial overrides,
  subsequent ordinary edits, one-undo whole-subtree removal, exact-ID redo/retry,
  atomic failure and mixed human/MCP history. Every field has a default/type/range;
  definition/source compatibility changes cannot silently erase user data.
  Copy semantics are explicit in API and proposed UI terminology.
- **Next:** 17.

## 17 — Stateful runtime, input and 2.5D physics contract

- **Outcome:** the synchronous fixed-step gameplay contract, independent of UI.
- **Depends on:** 14 measured recommendation, 15–16 schemas. **Gate:** E.
- **Read:** `contracts/runtime.md`, `contracts/dependencies.md` §6;
  runtime public types; decision-0002 draft; plan §3.4.
- **May edit:** `planning/m2-contracts/{input,physics,platformer}.md`, proposed
  `runtime.md`/model diffs, contract fixtures.
- **Public surface:** step-indexed `ActionFrame`, injected input/physics ports,
  fixed phase registration, module-owned transform policy and fail-stop lifecycle.
  Select exact collision tolerances and movement defaults from packet-14 evidence.
- **Failures:** focus/disconnect/hidden tab, repeated jump edges during catch-up,
  invalid parenting/scale, initialization cancellation, module throw after physics
  mutation, duplicate transform owner and unsupported module combination.
- **Acceptance:** table-driven numerical expectations for flat ground, just-below/
  just-above slope threshold, slide/snap, seams, ledges, jump apex/release/buffer/
  coyote windows, head/wall collision, high-speed movement and no Z drift.
  Specify neutral-input/fresh-resume rules, replay tolerances and no phantom steps
  after dropped wall time. All private-state failure paths require safe restart,
  not impossible transform-only rollback. Fixed static camera convention included.
- **Next:** 18.

## 18 — Trusted behavior execution and compilation contract

- **Outcome:** reviewable script trust and build boundary with declared properties.
- **Depends on:** 15–17 drafts. **Gate:** E (explicit owner trust disposition).
- **Read:** `contracts/runtime.md` §7/§11; `contracts/sessions.md` §13;
  `contracts/export.md` §5; packet-16 properties; plan §3.5.
- **May edit:** `planning/m2-contracts/behaviors.md`, proposed runtime/model diffs,
  malicious-import and declared-behavior contract fixtures.
- **Public surface:** declarative property schema, `BehaviorSpec` lifecycle and
  bounded intent API; `compileBehavior` over supplied immutable source bytes.
- **Failures:** source graph escape/cycle/size limits, forbidden bare/Node/network
  imports, dynamic eval/import, invalid intents, duplicate writers, exception/log
  floods, incompatible property update and compile timeout/failure.
- **Acceptance:** no server-side source evaluation/build hooks; stage → validate/
  compile → prepare digest-bound result → command publication is mandatory.
  Source publication changes revision; compilation failure cannot replace a good
  publication. Keep public publication unavailable until packet 33 implements the
  preparation path; distinguish that from a later full-snapshot build failure;
  pinned modules work identically in play/export. Specify compiler resource bounds
  separately from runtime trust. Clearly document that trusted main-thread scripts
  have **no hard runtime timeout or hostile-code sandbox**. Owner acceptance is
  required; if rejected, request a separate execution-boundary design packet.
- **Next:** 19.

## 19 — Delivery, protocol, export and dependency contract integration

- **Outcome:** one coherent M2 public boundary pack ready for Gate E.
- **Depends on:** 15–18; owner disposition of M1 U-4. **Gate:** E.
- **Read:** `contracts/{sessions,export,dependencies}.md`; protocol/backend services
  and exporter public APIs; proposals 15–18; M1 report U-4; plan §§3.6/4.
- **May edit:** `planning/m2-contracts/{delivery,contract-diffs}.md`, proposed
  sessions/export/dependencies diffs, decision-0002 draft, acceptance plan refinements
  (do not weaken promised outcomes), contract fixtures.
- **Public surface:** content/job queries and upload/stage protocol; authenticated
  committed asset-byte reads addressed by project/asset/immutable version; atomic
  snapshot capture; immutable play artifact locator; versioned bridge; bounded input relay;
  module build manifest, output closure and shared compiler interface.
- **Failures:** auth/origin/path leakage, stale capture/build, artifact expiry/reload,
  unavailable browser, overlarge full-state/change frame, malformed binary upload,
  missing dependency, blocked gamepad policy and failed first build in a cold process.
- **Acceptance:** exact routes/messages/error mappings, numeric bounds/timeouts,
  per-package exports/edges/pins and negative-test matrix; new runtime fetch policy
  plus format-aware scans; U-4 accept/reject decisions recorded. Specify snapping
  increments, coordinate space, scale limits and rounding/cancel rules in the
  sessions/gesture diff; this local-preview extension needs no persistent setting.
  No authoring credentials in preview (only the specified bounded read-only content
  capability), no service dependency in export, no binary content in WS state. Establish exact
  destination contract sections for every proposal and resolve conflicting drafts.
- **Next:** **Gate E review → explicit accepted-doc promotion → 20**, not automatic.

## 20 — Model v2 and pure migration

- **Outcome:** validated M2 logical data with safe M1 compatibility.
- **Depends on:** Gate E accepted and contracts promoted. **Gate:** F.
- **Read:** accepted model/assets/properties/prefabs/content-storage contracts;
  project-model public API and relevant fixtures.
- **May edit:** `packages/project-model/**`, `fixtures/m2/model/**`.
- **Public surface:** strict content/component/property validators, canonical
  serialization and pure M1-to-M2 conversion. Keep existing M1 public types/entry
  points compatible; introduce explicitly versioned M2 types rather than breaking
  every consumer in this packet. No filesystem migration here.
- **Failures:** unknown versions/fields, bad references, limits, duplicate IDs,
  invalid finite values and forbidden physics transforms.
- **Acceptance:** approved fixtures round-trip byte-exactly; all invalid fixtures
  fail non-destructively; migration retains source input and IDs as contracted;
  existing M1 fixtures/behavior unchanged; no I/O/three.js dependency.
- **Next:** 21.

## 21 — Pure content and property commands

- **Outcome:** normal M2 edits share the existing pure history engine.
- **Depends on:** 20. **Gate:** F.
- **Read:** accepted commands/assets/properties/content-storage contracts;
  model/commands public exports.
- **May edit:** `packages/commands/**`, `fixtures/m2/commands/**`.
- **Public surface:** approved non-prefab mutation/query request types,
  change/inverse records for assets, components, properties, settings and behavior
  publication. Prepared blobs are identifiers/validated data, not filesystem calls.
- **Failures:** stale revision precedes argument validation; invalid references or
  declaration replacement; request shape errors; no-change; redo invalidation.
- **Acceptance:** successful edits each consume one revision/history entry;
  inverses restore old content versions; failed edits leave inputs untouched;
  M1 semantics preserved. No workspace executor or alternate mutation path.
- **Next:** 22.

## 22 — Pure prefab capture and instantiation

- **Outcome:** reusable materialized subtrees through typed commands.
- **Depends on:** 21. **Gate:** F.
- **Read:** accepted prefabs/commands/properties contracts; public model/command API.
- **May edit:** `packages/project-model/**` (approved prefab helpers only),
  `packages/commands/**` (prefab operations/history), `fixtures/m2/prefabs/**`.
- **Public surface:** capture/instantiate helpers and prefab mutation change data.
- **Failures:** illegal captured subtree, external reference, unsupported nesting,
  invalid override, ID exhaustion and output scene limit exceeded.
- **Acceptance:** instantiate twice with distinct IDs and correctly remapped internal
  references; exact generated mapping in results; one undo/redo preserves identity;
  changes in one copy never affect another. Invalid input has no partial expansion.
- **Next:** 23.

## 23 — Workspace content publication and migration-copy workflow

- **Outcome:** durable M2 envelope/blob operations on the real filesystem.
- **Depends on:** 22. **Gate:** F.
- **Read:** accepted workspace/content-storage/assets/commands contracts;
  workspace public API, focused packet-07 repair tests, model/command exports.
- **May edit:** `packages/workspace/**`, `fixtures/m2/storage/**`.
- **Public surface:** approved stage/blob APIs, captured content read, v2 command
  execution and explicit operator migration-copy; no HTTP handlers. Behavior-source
  publication requires the approved digest-bound compiled preparation record;
  without the packet-33 preparer it is unavailable, not an unchecked write.
- **Failures:** SIGKILL before/after blob publication and envelope replacement;
  fsync failure, quota/full disk, second owner, symlink escape, external tampering,
  missing source/cache, expired stage, lost acknowledgement and concurrent reimport.
- **Acceptance:** fault/crash tests prove acked references and retry result durable;
  original v1 project is byte-identical after success/failure of migration-copy;
  dedup precedes stage lookup/revision checks; orphan blobs are harmless and reported;
  undo/retry/play pins remain readable after restart. Preserve repaired M1 ownership
  and external-change behavior. Use only disposable directories/processes.
- **Next:** 24.

## 24 — Bounded GLB inspection and import proposals

- **Outcome:** supported GLB bytes become a validated immutable import proposal.
- **Depends on:** 23. **Gate:** F.
- **Read:** accepted assets/content-storage contracts; public model/storage APIs;
  official pinned GLTFLoader/glTF documentation for the agreed profile.
- **May edit:** new `packages/asset-pipeline/**`, licensed/self-generated
  `fixtures/m2/assets/**`, root/package registration and approved dependency checks.
- **Public surface:** approved `inspectGlb`/`prepareImport` over bytes and injected
  job ports. Caller/workspace commits; importer cannot mutate authoring state.
- **Failures:** truncation, accessor/buffer overflow, external URI, unsupported
  extension, excessive decoded images/geometry, malformed clips and cancellation.
- **Acceptance:** tiny mesh/material/animation fixtures produce deterministic
  metadata/recipe hashes; rejected inputs leave current assets untouched; no URL
  requests or arbitrary plugin execution. Byte/decoded-resource/time limits tested
  with adversarial fixtures. Reimport same asset ID preserves whole-model references.
- **Next:** 25.

## 25 — Content HTTP services, projection data and MCP parity

- **Outcome:** UI and actual stdio MCP can query/publish M2 content through backend.
- **Depends on:** 24. **Gate:** F.
- **Read:** accepted commands/assets/delivery/sessions contracts;
  protocol/backend services/workspace/importer public exports; current MCP tools.
- **May edit:** `packages/{protocol,backend,mcp-adapter}/**`, approved registrations,
  `tests/integration/m2-content/**`.
- **Public surface:** approved asset upload/stage/jobs/queries/mutations, authenticated
  committed asset-byte reads by immutable version, and full-state/change events.
  Filesystem reads are workspace-injected; no transport-side writes. Byte reads
  cannot expose staged/arbitrary files or another project's versions.
  Behavior-build jobs/publication are unavailable until 33, not mocked as successful
  here; seeded declarations suffice for property-query tests. Versioned protocol additions must
  preserve the working M1 client until the M2 UI/Play wiring lands.
- **Failures:** unauthenticated/cross-project upload/read, malformed multipart or
  chosen binary framing, path escapes, disconnected client, oversize payload,
  late job result, stale reimport, replay after expired stage and restart.
- **Acceptance:** real backend + filesystem + SDK client import/query/instantiate/
  edit/retry flow; same command results for browser-origin and MCP-origin requests;
  bounded job errors; all changes reconstruct a current projection without sending
  GLB/source bytes over WS. Server-only operations do not require a browser.
- **Next:** **Gate F review → 26**.

## 26 — Shared GLB rendering and asset previews

- **Outcome:** one renderer resource path for model instances and asset inspection.
- **Depends on:** Gate F accepted. **Gate:** G.
- **Read:** accepted assets/runtime/delivery contracts; three-adapter public API;
  official documentation matching the pinned three.js loader and animation APIs.
- **May edit:** `packages/three-adapter/**`; focused `packages/editor/src/viewport/**`
  integration using public adapter helpers; renderer/browser fixture tests;
  approved bundle-graph tables for loader imports.
- **Public surface:** approved asset-byte resolver, async prepared visual resources,
  model instances, local material/animation preview controller and disposal.
  These helpers accept the approved visual descriptors independently of M1 runtime
  instantiation; M2 runtime snapshots arrive in 29 and production Play wiring in 35.
- **Failures:** stale async completion, cancelled loads, missing/corrupt asset,
  invalid image/clip, lost WebGL context and unsupported extension.
- **Acceptance:** real browser shows mesh/materials, plays/pauses/scrubs an embedded
  clip; two instances have independent transforms/animation state and correct
  resource ownership. Repeated load/reimport/dispose releases owned GPU/CPU/listener
  resources; screenshot is not tainted. No alternate scene mutation engine.
- **Next:** 27.

## 27 — Content browser, placement/reimport and snapping

- **Outcome:** useful asset authoring without hand-editing JSON.
- **Depends on:** 26. **Gate:** G.
- **Read:** accepted assets/commands/sessions contracts; client/projection public
  interfaces; packet-26 rendering surface; approved snapping behavior from Gate E.
- **May edit:** `packages/editor/**` (asset panels, projection/client, viewport/gizmo),
  `tests/browser/m2-assets/**`.
- **Public surface:** panels consume API queries/jobs and issue typed commands;
  snapping is a local gesture option, not a second persistent authority.
- **Failures:** failed upload/reimport, stale job, conflict/reconnect, invalid drop,
  cancel gesture and remote edit during drag.
- **Acceptance:** import → preview → place twice → reimport visibly updates references
  without entity-ID/transform changes; failure preserves old content. Translate,
  rotate and scale snapping use approved increments; zero commands during drag,
  exactly one on release, one undo; cancellation sends none. No decorative or graph UI.
- **Next:** 28.

## 28 — Prefab and declared-property authoring UI

- **Outcome:** create/reuse prefab copies and edit typed properties/components.
- **Depends on:** 27. **Gate:** G.
- **Read:** accepted prefabs/properties/commands/sessions contracts; projection and
  packet-25 public query surfaces.
- **May edit:** `packages/editor/**` (prefab, inspector, component controls/projection),
  `tests/browser/m2-prefabs/**`.
- **Public surface:** command-driven prefab capture/instantiate and schema-driven
  controls for published declarations/collider/controller properties.
- **Failures:** unknown declarations, invalid numeric/reference input, unsupported
  overrides, stale revision and backend-rejected instance limit.
- **Acceptance:** real-browser capture/two instances/edit one/undo/redo/reopen;
  MCP edits visibly converge without reload. Controls expose defaults/types/errors,
  never discover properties by evaluating code. Seeded declarations may be used
  here; **actual authored-script execution is not claimed until 34–35**.
  UI clearly says copies, not linked prefabs; no apply/revert/variant controls.
- **Next:** **Gate G review → 29**.

## 29 — Stateful runtime scheduling and module lifecycle

- **Outcome:** safe fixed-step composition before integrating physics or scripts.
- **Depends on:** Gate G accepted. **Gate:** H.
- **Read:** accepted runtime/input/physics/behaviors contracts; runtime public API
  and current fixed-step tests.
- **May edit:** `packages/runtime/**`, runtime fixtures; no concrete physics library.
- **Public surface:** approved module phases, injected ports/action frames,
  transform ownership, initialization/cancellation and failed runtime lifecycle.
- **Failures:** duplicate writer, module order mismatch, throw after private-state
  mutation, initialize/dispose race, catch-up overflow and restart-after-failure.
- **Acceptance:** same step-indexed inputs produce contracted state traces; at most
  eight steps per frame; no input-edge duplication or phantom elapsed steps;
  fail-stop renders only last committed state and cannot resume corrupted state;
  repeat teardown is idempotent. M1 demo stays supported and source snapshot frozen.
- **Next:** 30.

## 30 — Keyboard and gamepad actions

- **Outcome:** focused browser input becomes bounded, testable action frames.
- **Depends on:** 29. **Gate:** H.
- **Read:** accepted input/runtime/delivery contracts; runtime public ports;
  official browser Gamepad/Permissions Policy APIs.
- **May edit:** new `packages/input/**`, approved package/bundle registrations,
  `tests/browser/m2-input/**`; no backend input polling.
- **Public surface:** pure mapping/sampling and explicitly attached browser listener
  owner, separate injectable step-input source for tests.
- **Failures:** blocked/insecure API, absent/nonstandard device, reconnect/index reuse,
  key repeat, hidden tab/focus loss, typing in inspector and multiple input sources.
- **Acceptance:** actual keyboard **and physical controller** on named desktop
  browser; dead zone, press/hold/release, hot disconnect and blur release tested.
  Pure tests establish exact sampled frames; browser logs establish API/focus
  behavior. No synthetic gamepad-only claim. Cleanup removes listeners and held state.
- **Next:** 31.

## 31 — Rapier 2D adapter

- **Outcome:** approved collision port backed by the selected real library.
- **Depends on:** 30; approved exact physics pin from Gate E. **Gate:** H.
- **Read:** accepted physics/runtime contracts; decision 0002; packet-14 evidence;
  runtime ports and version-matched Rapier APIs.
- **May edit:** new `packages/physics-rapier/**`, approved lockfile/dependency/bundle
  checks, `fixtures/m2/physics/**`.
- **Public surface:** async initialization before runtime start, static collider
  creation, character movement correction/support results, dispose and diagnostics.
- **Failures:** WASM load/init cancellation, invalid shape, forbidden transform,
  stale world handle, collision correction failure and dispose during preparation.
- **Acceptance:** real library tests for capsule/floor/wall/ceiling/convex ramps,
  slope normals/ground snap; no Z dimension in collision, no second frame driver;
  many create/dispose cycles release world resources. Browser build works with
  approved CSP/static packaging; runtime core imports no Rapier implementation.
- **Next:** 32.

## 32 — 2.5D platformer controller and diagnostic course

- **Outcome:** one controllable character traverses the bounded test course.
- **Depends on:** 31. **Gate:** H.
- **Read:** accepted platformer/input/physics/runtime contracts; public input/physics
  ports; packet-14 course/evidence criteria.
- **May edit:** new `packages/platformer/**`, approved registrations,
  `fixtures/m2/course/**`, `tests/browser/m2-controller/**` (temporary test host,
  not a duplicate production bootstrap).
- **Public surface:** pure controller state/intent and runtime module over injected
  physics/input ports; no three.js or authoring dependency.
- **Failures:** slope limit, seam jitter, coyote/buffer off-by-one, repeated jump,
  ceiling strike, fast wall approach, loss of focus and long tab stall.
- **Acceptance:** numerical contract tests plus actual browser course with keyboard
  and physical gamepad; single-jump/variable-height/grounding/sliding behavior
  measured at approved tolerances; Z locked; snapshot unchanged. Record CPU costs
  on packet-14 fixture/reference setup, not speculative product budgets. No M3
  camera follow, respawn, hazards, animation state machine or complete game.
- **Next:** **Gate H review → 33**.

## 33 — Immutable behavior builds

- **Outcome:** published trusted sources compile into a pinned browser artifact.
- **Depends on:** Gate H accepted. **Gate:** I.
- **Read:** accepted behaviors/properties/delivery/export contracts; workspace
  captured-content API; esbuild documentation for the pinned version.
- **May edit:** new `packages/behavior-build/**`, approved package/build checks,
  focused `packages/backend/**` behavior-job/publication facade wiring,
  `fixtures/m2/behaviors/**`, `tests/integration/m2-builds/**`.
- **Public surface:** static source-graph validation and shared `compileBehavior` /
  artifact-manifest builder with injected source reader; no code evaluation.
  Enable public source publication only after stage validation/compilation succeeds;
  the prepared result binds exact source/declaration/recipe digests and feeds the
  existing workspace command executor, never a second commit path.
- **Failures:** Node/backend imports, dynamic import/eval, graph escape, invalid
  declaration, timeout/size limit, stale source digest and compiler process failure.
- **Acceptance:** valid typed sample builds reproducibly; hostile import probes fail;
  source code is never imported/executed in backend tests; old successful artifact
  survives every failure. Fresh-process cold builds tested repeatedly using actual
  deployed esbuild arrangement (M1 U-2), with observed failures recorded honestly.
- **Next:** 34.

## 34 — Trusted behavior execution and publication UI

- **Outcome:** a published behavior's declared property actually affects play state.
- **Depends on:** 33. **Gate:** I.
- **Read:** accepted behaviors/properties/runtime contracts; runtime phase API,
  compiler public exports and existing typed inspector.
- **May edit:** `packages/runtime/**` (approved behavior host only),
  `packages/editor/**` (trust/build/property workflow),
  `tests/browser/m2-behaviors/**`; no new sandbox architecture.
- **Public surface:** behavior instance lifecycle, validated intents and bounded
  diagnostics; UI uses existing publication command/jobs, never a source evaluator.
- **Failures:** bad intent/property, module throw/log flood, two writers, failed
  build/publish and stale declaration. Do not run an unbounded-loop test in a live
  user's browser; inability to preempt trusted same-thread code remains documented.
- **Acceptance:** test host runs compiled example, changing published numeric
  property changes measured behavior after fresh instantiation; source snapshot
  unchanged; exceptions fail-stop and report bounded diagnostics; trust warning is
  explicit. Staged edits do not change active play or published revision.
- **Next:** 35.

## 35 — Content-aware play delivery and bounded MCP input

- **Outcome:** production isolated Play composes assets/input/physics/controller/scripts.
- **Depends on:** 34. **Gate:** I.
- **Read:** accepted delivery/sessions/runtime/behaviors contracts; protocol and
  backend services public surfaces; renderer/input/physics/platformer/build exports.
- **May edit:** `packages/{protocol,backend,mcp-adapter}/**`,
  `packages/editor/src/preview/**`, editor play/session wiring, approved build
  bootstrap graphs, `tests/integration/m2-play/**`.
- **Public surface:** immutable play build/pins and locator, versioned bridge,
  ready/failure/load progress, scoped artifact server, action-exercise relay.
- **Failures:** bad origin/source/nonce, expired locator, path traversal, missing
  artifact, stop during load, reload, backend restart, script exception, browser
  disconnect, denied gamepad permission and injected/physical input conflict.
- **Acceptance:** real production browser Play loads pinned GLB and behavior, traverses
  course, reports true readiness, and survives repeated stop/start without leaks.
  Reimport/source publication during play does not change it. Real SDK input relay
  runs a bounded sequence in exclusive test mode, returns step/snapshot provenance;
  no-browser fails structurally. Capture a real rendered PNG. Preview contains no
  authoring credentials and makes no authoring API calls; negative security tests pass.
- **Next:** 36.

## 36 — Standalone M2 content/gameplay export

- **Outcome:** complete reachable content and the same gameplay run without backend.
- **Depends on:** 35. **Gate:** I.
- **Read:** accepted export/delivery/assets/behaviors/dependencies contracts;
  exporter/public workspace capture APIs and shared build/module exports.
- **May edit:** `packages/exporter/**`, focused backend export facade/wiring,
  approved export/bootstrap build checks, `tests/integration/m2-export/**`,
  `acceptance/deployment.md` (M2 static-serving instructions only).
- **Public surface:** approved export result/metadata, artifact closure and common
  behavior compiler; no separate controller/runtime implementation.
- **Failures:** source/asset missing or corrupt, stale authoring capture, unsupported
  module, forbidden graph/string/resource URI, failed temp-output publication,
  cold build failure, non-root static path and WASM MIME/CSP/init failure.
- **Acceptance:** two same-input exports are byte-identical except agreed timestamp;
  exact versions/licenses/hashes recorded; failed export leaves previous output
  untouched. Real browser plays course with keyboard/controller from independent
  static server, backend stopped/unreachable, no external requests. Negative source
  and credential probes rejected. Play/export trace agrees for fixed action input
  within approved physics tolerance.
- **Next:** **Gate I review → 37**.

## 37 — Integrated M2 acceptance and bounded deployment documentation

- **Outcome:** reviewed evidence that M2 is usable end to end, not disconnected demos.
- **Depends on:** Gate I accepted. **Gate:** J.
- **Read:** `planning/m2-acceptance.md`; handoffs 23–36 **summaries/evidence indexes**;
  `acceptance/deployment.md`, decision 0002. Inspect contracts/source selectively
  when a failure requires them, not the entire implementation tree.
- **May edit:** `acceptance/m2-report.md`, `acceptance/evidence-m2/37/**`,
  `acceptance/deployment.md` (M2 setup/trust/source-backup/secure-context additions),
  `handoffs/37.md`. Source defects become separately scoped repair tasks with their
  original packet read/edit sets; no blanket permission to edit all packages.
- **Public boundary:** disposable project and actual deployed backend/editor/MCP
  artifacts; no new product API.
- **Failures/evidence:** execute every acceptance row, including migration-copy,
  malformed reimport, stale/conflicting commands, process crash/restart, missing
  cache/source, script compile/runtime failure, physical controller disconnect,
  snapshot immutability and standalone export. Retain sanitized replayable evidence
  in repo, not only ephemeral `/tmp` paths. Record U-1…U-5 disposition individually.
- **Acceptance:** all required browser/hardware/durability/export rows pass; no mock
  substitution or fabricated performance. Include clean-install tools/boundaries,
  current pins and exact deployment instructions, separating supplied configuration
  from actually performed setup. No host service or TLS installation without owner
  authorization. Missing real browser/gamepad evidence means incomplete acceptance.
- **Next:** **Gate J review → STOP.** After acceptance, the next work is the separate
  **M3 planning prompt** in implementation-prompts.md, only on owner request.

## Gate review prompt (E–J)

Review the named gate from its contracts, scoped diff and raw evidence. Do not
implement features or treat an implementation handoff as proof. Check ownership,
public edges, revision/retry ordering, immutable-content durability, version
compatibility, resource disposal, script trust, input/physics behavior and export
independence as applicable. Re-run meaningful checks where possible and distinguish
executed evidence from reported evidence. List prioritized concrete failure cases,
minimal repair scope, blockers versus bounded follow-ups and the exact next step.
State accept / accept with bounded follow-ups / changes required; record missing
context and unverified targets. Never claim a separate reviewer approved your own
review. A contract change reopens Gate E's affected portion. Do not auto-start work.
