# M4 task packets — 63–82

**DRAFT · all packets pending · planning only.** Read [m4-plan.md](m4-plan.md)
first. Acceptance IDs below refer to [m4-acceptance.md](m4-acceptance.md).

## Common execution rules

- Read `AGENTS.md`, `docs/STATUS.md`, the assigned packet, its prerequisite
  handoffs, relevant plan §2, assigned C-rows, and only named contracts/public APIs
  before relevant implementation/tests. `contracts/`, `planning/`, `handoffs/`,
  `acceptance/` below are relative to `docs/`; other paths are repository-relative.
- All packets read `contracts/dependencies.md` §§2–5/7/9. Use the recorded Node/npm,
  exact package pins and lockfile; no opportunistic dependency/renderer upgrade.
  Preserve the existing dirty M2/M3 tree. Work sequentially, not concurrent edits.
- Common allowed writes: `docs/handoffs/<ID>.md`, the assigned STATUS row and
  `docs/acceptance/evidence-m4/<ID>/**`. Other writes are listed per packet.
  No live user-project edits, deployment, pushes, commits, installations of system
  services or unrelated cleanup. Do not stop the harness/session daemon.
- 63–68 draft under `planning/m4-contracts/` only. Every proposal defines exact
  shape/public API, validation order, limits, errors, ownership/disposal, revision/
  history semantics, compatibility and fixtures. List exact old/new contract
  sections, with a single owner per destination; do not silently change accepted
  contracts. Later packets consume **promoted** contracts, not proposals.
- **M4 proposal convention (PR-M4-1, plan review 2026-09-21):** every
  `planning/m4-contracts/*.md` proposal opens with a "Relation to the accepted
  contracts" section naming (a) the exact `docs/contracts/**` sections its owned
  diff rows change, (b) its new home file after promotion
  (`docs/contracts/{templates,distribution,reliability}.md` where applicable), and
  (c) which M3 proposal document of the same base name (e.g.
  `planning/m3-contracts/delivery.md`) is unrelated. 67-A/67-B, 70-A/70-B and
  73-A/73-B execute inside one packet handoff each with per-part evidence sections
  (PR-M4-6).
- Gate Q review → bounded repairs → separate docs-only promotion handoff
  `handoffs/m4-promotion.md` → implementation. Gate verdict and owner execution
  authorization are separate. No gate is approved by this plan.
- Every implementation packet runs targeted tests and `npm test`,
  `npm run typecheck`, `npm run check-deps`, `npm run check-boundaries`,
  `npm run build`, plus M1/M2/M3 regression/fixture checks applicable to changed
  boundaries and the M4 fixture checker. Negative controls must demonstrate that
  scanners/fixture checks reject actual corruption. Keep evidence writes explicit,
  not automatic updates from ordinary tests. Review gates include a clean `npm ci`
  run in a disposable copy of the actual tree, not HEAD-only `git archive`.
- Browser proof uses actual production pages, DOM/canvas captures, console/network
  and state traces. Injected/test controls and physical controls are different
  evidence. Record device/browser/origins/secure context/GPU/DPR/input/audio facts.
  No file named `browser.test.ts` establishes a browser run by itself.
- Handoff: outcome, changed files or scoped diff/actual commit, commands/results,
  acceptance PASS/FAIL/UNVERIFIED, limitations, numbered contract requests, exact
  next packet/gate. A packet ends there. Unavailable hardware is UNVERIFIED, never
  inferred. If a scope cannot fit, stop with the bounded remainder; do not invent
  a cross-system redesign to finish it.

## 63 — Current-baseline audit and reference-device measurement path

- **Outcome / dependency / gate:** reproducible M3 carry-forward ledger and real
  measurement route; plan review + separate execution authorization / Q.
- **Read:** plan §1/§2.6; M3 report §§3–6; handoffs 55, 58–62, Gates N/O/P and
  test-hygiene-2026-09-21; `acceptance/deployment.md` §§5/8 onward;
  `planning/m3-contracts/baseline.md`; runtime/game-host/adapter public exports;
  existing `tests/evaluations/m3-browser/` harness entry and packet-62 evidence.
- **May edit:** `tests/evaluations/m4-baseline/**`,
  `planning/m4-contracts/{baseline,debt-ledger,reference-device}.md`; no product
  source, package/lockfile, accepted contract or historical verdict changes.
- **Boundary:** run built editor + isolated preview + standalone sample; identify
  rendered movement, absent model attachment, settings reconnect/query gaps and
  CC-55-3's actual meanings. Ledger rows require source/evidence, current status,
  owner/checkpoint and proposed disposition. Separate stale docs from real defects.
  Record actual export symbol names for the pending K-3 owner confirmation.
- **Failures:** no connected preview, static canvas despite changing runtime state,
  absent media, wrong CSP, stale sample, software GPU, unavailable physical devices.
  Capture failures rather than repair them here. Ask for reference desktop/target
  decisions together; if unavailable, specify exactly which branch is blocked.
- **Evidence / accept:** C01; executable probes with raw logs/canvas + state at
  known frames, capability table and baseline timing samples where possible.
  The ledger reconciles CC-55-3 without claiming either record is authoritative
  by recency alone. All unresolved facts have owners. **Next 64.**

## 64 — Delivered rendering, queries and compatibility repair contract

- **Outcome / dependency / gate:** exact minimal diffs for observed delivery/read
  gaps / 63 / Q.
- **Read:** 63 ledger; presentation §§41.0/41.3/41.5–41.7/41.9;
  runtime §§6/8/15; commands §§5.6 and settings/query sections;
  sessions §§13/17/19–20; export §5; adapter visual/animation and game-host public
  types; editor session query interfaces.
- **May edit:** `planning/m4-contracts/delivery.md`, owned rows in
  `planning/m4-contracts/diffs/{presentation,runtime,commands,sessions,export,dependencies}.md`,
  `fixtures/m4/delivery/**` including checker.
- **Boundary:** specify injected model attachment/resource lifetimes, independent
  animation, single update loop, stale load cancellation, corrupt-vs-degraded
  outcomes and both-host loading order. Keep adapter root loader-free; identify
  the explicit GLTFLoader entry and exact graph/scan remeasurement requirements.
  Specify bounded settings-value query (including explicit vs resolved values)
  and accepted queryProject summary; carry revision on every read. No second
  catalog, default-based reconnect guess or new mutable settings store.
- **Failures:** late completion after stop/reimport, missing clip/blob, shared
  mixer state, animation moving physics root, hidden/disposed run, mismatched
  read revision, unsupported behavior scene. Split HUD wording from behavior
  linking if 63 confirms both. Propose built-in-only template and explicit
  source-bearing refusal; request a scope decision for contradictory export text.
- **Evidence / accept:** C02/C03/C06/C07/C14; fixtures specify observable rendered
  and numeric expectations, query shapes/errors, bounds and compatibility.
  Behavior scope is an explicit Q decision, not silently erased support.
  **Next 65.**

## 65 — Template, initialization, module requirements and layout contract

- **Outcome / dependency / gate:** one creatable, safely copied platformer template
  with independent layout/module semantics / 63–64 / Q.
- **Read:** charter §§3–5; project-model version tables/§§18–23;
  commands creation/prefab/settings/game configuration sections; workspace
  §§6/8/13/16; sessions admin/content routes; sample recipe public workflow.
- **May edit:** `planning/m4-contracts/templates.md`, owned diffs for
  model/commands/workspace/sessions/dependencies; `fixtures/m4/templates/**`.
- **Boundary:** freeze template descriptor/version/hash, finite approved modules
  and dependency resolution, starter command/data inventory, initial layout,
  provenance storage and full new-project create/query lifecycle. Every template
  value has a command authoring path. Require two independent decoration prefab
  instances and visible animated content. Choose exact revision/history/retry and
  new-identity rules; specify reservation/staging/final publication and resumable
  marker phases. No arbitrary template execution or archive extraction.
  Define creation permission, idempotent request/result, destination collision,
  UI/MCP status and bounded progress. Freeze local-only panel preferences and reset.
- **Failures:** wrong engine/template version, missing module/reference/blob,
  dependency cycle, path traversal/symlink, invalid name/ID, disk-full, duplicate
  create, concurrent destination claim, crash each phase, invalid local layout.
- **Evidence / accept:** C04–C06/C09/C10; fixtures include identity independence,
  command recipe validity, every failure phase and hidden-panel invariant. Include
  create-from-v1→remove/replace-installed-template→reopen/build-old-project;
  old content remains identical, new creation records the new template identity.
  Any schema bump names exact combinations and migration, otherwise keep existing
  closed schemas unchanged. **Next 66.**

## 66 — Portable pinned engine kit and independent build contract

- **Outcome / dependency / gate:** precise local distribution/build boundary that
  does not require this checkout / 63–65 / Q.
- **Read:** plan §2.3; dependencies §§2–5/7; export §§2–7;
  package manifests/public exporter/workspace entries; `tools/build.mjs` and its
  graph/path assumptions; `acceptance/deployment.md` engineRoot requirements;
  engine/sample license files and existing provenance inventory.
- **May edit:** `planning/m4-contracts/distribution.md`, owned diffs for
  dependencies/export/workspace; `fixtures/m4/distribution/**`.
- **Boundary:** freeze engine-kit allowlist/tree, source/file/lock digest identity,
  game pin/lockfile ownership, npm working directories, public Node build tool,
  path containment and build inputs. Decide an installable source-kit layout
  using existing exact pins; packaging must not smuggle registry dependencies
  for private workspace packages. Document build-only versus runtime dependencies
  and the exact normalized graph paths. No public publishing or license grant.
- **Failures:** dirty tree falsely identified by commit, missing package/lock,
  transitive floating dependency, stale pin, engine kit tamper, reliance on cwd,
  absolute checkout path, symlink escape, unavailable registry during clean install,
  secret/license omission and forbidden runtime import.
- **Evidence / accept:** C08/C12; enumerate an executable isolated-install/build
  smoke procedure and positive/negative package inventories. No fake engine tag
  or mutable parent checkout link. Record any new tool/unit edge for Q.
  **Next 67.**

## 67 — Recovery, diagnostic and measured-budget contracts

- **Outcome / dependency / gate:** bounded reliability operations and testable
  reference-device thresholds / 63–66 / Q.
- **Read:** workspace §§5–7/10/13/15/16; commands errors; sessions diagnostics and
  auth; runtime diagnostics; presentation capability/resource lifetime sections;
  deployment §5 and later backup addenda; 63 reference-device results.
- **May edit:** `planning/m4-contracts/reliability.md`, owned diffs for
  workspace/sessions/runtime/dependencies and deployment replacement proposal;
  `fixtures/m4/reliability/**`.
- **Boundary:** execute as two bounded parts with one handoff: **67-A** consistent
  backup inventory/verify/restore, diagnostic envelope/limits/redaction, recovery
  fault matrix; **67-B** named device, scene, protocol, measured baselines and
  numerical thresholds for plan §2.6. If representative media/hardware is not yet
  available, Q accepts only the protocol and explicitly defers 67-B's numerical
  table. Resume 67-B after 76/78 on the completed game: 79's candidate-assembly
  preflight may run first, but no scored run until target review/promotion and
  owner confirmation in `handoffs/67-budget-ratification.md`. Early box-only data
  is not representative calibration. Existing workspace owns state; offline tools
  operate only after release/stop. Same-ID restore, new-ID creation are distinct.
  Declare backup retention manual (no silent source/backup pruning).
- **Failures:** live project, truncated backup, missing/superseded blob, bad hash,
  ownership included, nonempty destination, symlink/path escape, disk/write fault,
  crash before final publication, stale diagnostic identity, secret/log overflow,
  invalid/disjoint timer and inadequate hardware.
- **Evidence / accept:** C09–C11/C13; fixtures prove refusals retain originals;
  proposed targets trace to measurements and owner device choice. Unmeasured
  thresholds stay explicitly blocked, not invented. Q records whether independent
  non-performance work can proceed while 67-B awaits hardware. **Next 68.**

## 68 — Contract inventory, fixture audit and Gate Q submission

- **Outcome / dependency / gate:** one internally coherent review pack / 63–67 / Q.
- **Read:** all four proposed contract briefs/diffs, their referenced destination
  sections, acceptance C01–C16 and debt ledger; no repository-wide implementation
  review.
- **May edit:** `planning/m4-contracts/{contract-diffs,traceability}.md`, bounded
  cross-pack reconciliation of 64–67 proposals, `fixtures/m4/audit/**`,
  `docs/decisions/0004-m4-reliability-and-templates.md` as PROPOSED only.
- **Boundary:** inventory every diff with author, exact destination, fixture,
  consumer, version/graph effect and proposed/accepted/rejected/deferred status.
  Trace template field→command→UI/MCP→storage→module closure→both hosts→acceptance.
  Reconcile collisions explicitly. Include pending owner K-3/behavior-scope/device
  decisions; do not infer approval from M3's execution authorization.
- **Failures:** missing creation path, template JSON bypass, hidden panel disabling
  module, kit depending on monorepo paths, live-backup assumption, physical-only
  excuse for a product gap, absent thresholds labelled PASS, contradictory errors.
- **Evidence / accept:** all fixture checkers + deliberately corrupt module edge,
  destination identity, kit digest and backup inventory; failures must exit nonzero.
  Every C-row has implementation/evidence owners. **Next Gate Q review, repairs
  and explicit docs-only promotion; not 69 automatically.**

## 69 — Scene model attachment and animation resource ownership

- **Outcome / dependency / gate:** model entities actually attach/render using the
  existing resource and animation owners / accepted Q + promotion / R.
- **Read:** promoted 64 contracts; adapter public visual/animation/scene APIs and
  relevant tests; presentation §§41.3/41.5/41.6.
- **May edit:** `packages/three-adapter/src/**` limited to scene attachment,
  animation/resource lifecycle and their tests; `tests/integration/m4-render/**`.
  Package exports only as promoted; no version upgrade or scene mutation code.
- **Boundary:** implement the approved injected attach surface, independent
  per-entity mixers/actions, one host-driven update and refcounted resources.
  Keep gameplay root transforms under runtime control. Cancel/detach/dispose
  deterministically, including async failure/late resolution.
- **Failures:** shared animation state, missing clip, model remove/reimport during
  load, dispose twice, root translation contamination, detached resource leak.
- **Evidence / accept:** C02/C13; real loader/mixer plus real browser visible
  model/pose frames, two instances at distinct states, ownership counters at
  baseline after repeated cancellation/dispose. Numeric mixer tests alone are
  insufficient. **Next 70.**

## 70 — Both production hosts: visible motion, captured media and failure paths

- **Outcome / dependency / gate:** same rendered gameplay in preview and export /
  69 / R.
- **Read:** promoted 64 delivery contracts; game-host public APIs; preview M3
  wrapper; exporter M3 bootstrap/public closure/graph tests; editor viewport/model
  instance public wiring; 63 failure evidence.
- **May edit:** `packages/game-host/src/**` scoped to approved adapter wiring;
  `packages/editor/src/preview/preview-m3.ts` and bootstrap wiring;
  `packages/exporter/src/export-bootstrap-m3.ts` and M3 bundle/graph/scan wiring;
  `packages/editor/src/viewport/` media attachment/reimport/disposal wiring only;
  `tests/integration/m4-delivery/**`, `tests/browser/m4-delivery/**`.
- **Boundary:** execute bounded parts **70-A** (both game wrappers) and **70-B**
  (authoring viewport), each with its own handoff evidence. Pass captured verified
  bytes/roles into 69's public API, never a
  fetch/token in game-host/adapter. Prove runtime motion reaches the canvas,
  startup waits/fails correctly, stop drops late loads and both wrappers use one
  composition. Implement only the accepted CC-55-3 disposition; no script loader
  sneaked into the built-in-only profile.
- **Failures:** stopped/expired preview, corrupt model/audio, bad CSP/MIME,
  reimport during pinned Play, no-WebGL vs shadow-off, silent audio denial,
  unsupported behavior, malicious graph/content and off-origin fetch.
- **Evidence / accept:** C02/C03/C07/C12/C14; browser frames and committed motion
  for actual Start→move→death→respawn in each host, with rendered animation.
  Viewport browser evidence also proves visible model attachment, reimport refresh,
  disposal on project switch and material/light consistency without running game
  simulation in the authoring viewport. Remeasure exact scan rows; differences
  require a bounded review/promotion before
  acceptance, not editing scan expectations to observed values alone.
  **Next 71.**

## 71 — Authoritative settings reads and query parity

- **Outcome / dependency / gate:** existing projects reopen with actual values and
  bounded, contract-correct queries / 70 (sequential workflow) / R.
- **Read:** promoted 64 query diffs; commands/workspace query public APIs;
  protocol result types; editor gameplay session and MCP query registrations.
- **May edit:** query handlers/types/tests in `packages/{commands,workspace,protocol,backend,mcp-adapter}/`;
  editor settings projection/control hydration only; `tests/integration/m4-queries/**`.
- **Boundary:** fulfill queryProject summary and settings-value reads at one
  revision through existing dispatch. UI initializes/resyncs from backend values,
  not last local edits/defaults. No new mutation path or default-setting rewrite.
- **Failures:** stale response after newer change, reconnect/resync, no explicit
  setting vs resolved default, v1/v2 project, invalid filter/limit, unauthorized
  query and mismatched projection version.
- **Evidence / accept:** C06/C07; real HTTP + WS + stdio-MCP + editor browser:
  change non-default speed/gravity, disconnect/reopen, values persist; undo and
  concurrent stale edit preserve revision semantics. **Next Gate R review.**

## 72 — Workspace template creation and starter recipe

- **Outcome / dependency / gate:** validated template creates independent durable
  projects through the workspace owner / accepted R / S.
- **Read:** promoted template contract, workspace create/content/migration APIs,
  command engine public surface, Beacon Reach recipe and provenance.
- **May edit:** `templates/platformer/**`; scoped initialization/template public
  methods and tests in `packages/workspace/`; pure descriptor/module validation
  in `packages/project-model/` only as approved; `tests/integration/m4-template/**`
  and `tests/crash/m4-template*`.
- **Boundary:** implement the approved pure module-requirement resolver on the
  project-model public surface, reusable by creation and capture/build callers.
  Execute approved bounded recipe using command engine, publish
  immutable sources and final valid destination according to Q's marker protocol.
  Two prefab decorations, animated model, checkpoint/hazard/goal/audio and copied
  presets must be authored normally. Include source/license/hash inventory.
- **Failures:** repeated/concurrent create, destination exists, wrong module/pin,
  missing asset, invalid command, interrupted creation each phase, write failure.
- **Evidence / accept:** C04/C05/C09; real filesystem and SIGKILL tests, resume
  only the matching operation, no ready partial project; two projects edit
  independently and reopen with valid integrity, even after the installed template
  is removed/replaced. Originals byte-identical after
  all refusals. **Next 73.**

## 73 — Template lifecycle through backend and MCP

- **Outcome / dependency / gate:** one discoverable bounded creation operation /
  72 / S.
- **Read:** promoted template routes/permission rules; protocol parsers, backend
  application services and MCP client/tool public patterns.
- **May edit:** scoped request/result/error/route/tool additions in
  `packages/{protocol,backend,mcp-adapter}/`; approved calls to the public module
  resolver in exporter closure/validation and backend Play capture;
  `tests/integration/m4-template-api/**` and `m4-module-closure/**`.
- **Boundary:** execute two bounded parts: **73-A** lifecycle transport; **73-B**
  ordinary Play/export capture validation. 73-B uses 72's single public resolver
  over current declarations/referenced content at each capture, including after
  authoring edits. Exporter's public build path carries the same check into 75's
  independent build; do not duplicate the resolver or infer modules from layout.
  73-A dispatches to 72, no file copying or command replay in transports.
  Same template inventory/status/results for both clients; explicitly admin-scoped
  creation, project-scoped editing afterwards. No credentials cross preview or
  appear in generated projects, logs or results.
- **Failures:** unauthorized creation, stale/mismatched operation identity,
  malformed/oversized descriptor, duplicate request, disconnect/lost ack,
  no browser, destination collision and timeout while operation continues.
- **Evidence / accept:** C04/C07/C14; real backend + SDK stdio calls create and
  retry one destination; project-only token denied admin creation; server-only
  create succeeds without a browser. Post-creation required-module omission,
  incompatible registry pin and unsupported newly referenced content reject both
  Play/export before publication; a valid later edit still builds. Test ordinary
  and independent build paths (the latter repeated at 75/76). **Next 74.**

## 74 — Template UI and separate panel visibility preferences

- **Outcome / dependency / gate:** create/open a template project visually; hide
  panels without changing gameplay / 73 / S.
- **Read:** promoted template/layout contract and API; editor App/session public
  patterns; module-closure fixtures.
- **May edit:** `packages/editor/src/{ui,session}/` scoped creation/status/layout
  controls and tests; relevant `editor.css`; `tests/browser/m4-template-ui/**`.
- **Boundary:** simple template picker/name/create/status/open and existing panel
  toggles/reset. Creation uses 73 with approved authorization; layout overrides
  stay local, bounded and discardable. Do not add docking framework or backend
  layout writes. Hidden panels retain authored data and dirty edits safely.
- **Failures:** denied create, retry/collision, partial initialization, corrupt
  preference version, all panels hidden, reconnect, project switch and stale UI.
- **Evidence / accept:** C04/C06; real browser creates/reopens project, hides
  gameplay/media panels, replays/exports and shows identical scene/content/module
  closure hashes and no authoring revision change. Reset restores usability;
  another browser's layout does not change. **Next 75.**

## 75 — Local engine-kit build and isolated toolchain

- **Outcome / dependency / gate:** a pinned self-contained development kit,
  without a public package release / 74 / S.
- **Read:** promoted distribution contract; exact package exports/lockfile;
  existing build/graph/boundary tools; exporter/workspace public APIs.
- **May edit:** `tools/distribution/**`, narrowly approved build/path-normalization
  seams in `tools/{build,check-boundaries,check-deps}.mjs` with tests;
  public exporter build-context seam only if Q explicitly names it;
  `tests/integration/m4-distribution/**`. Manifests/lockfile only for approved
  tooling entries/dependencies, never pin upgrades or blanket re-locking.
- **Boundary:** deterministic allowlisted kit and file inventory, actual source
  identity, exact nested lockfile/toolchain and reviewed public build command.
  Node tooling can use public APIs, not cross-package internals. Source kit is
  immutable input; installed dependencies/outputs are disposable.
- **Failures:** artifact tamper, floating pin, private dependency accidentally
  resolving from registry, missing notices/file, absolute path, cwd assumption,
  secret inclusion, source-tree mismatch and forbidden bundle edge.
- **Evidence / accept:** C08/C12; two kit builds hash-identical under contracted
  normalization, install and build in two unrelated disposable directories with
  original checkout inaccessible, graph/content scans including negative controls.
  Record registry use; no offline-install claim without an actual cached test.
  **Next 76.**

## 76 — Independent game built from the template

- **Outcome / dependency / gate:** a second game, not a renamed export or engine
  fork / 75 / S.
- **Read:** promoted template/distribution contracts, 72–75 handoffs and template
  documentation; source/prefab/media authoring public commands.
- **May edit:** `samples/m4-independent/**` (recreation recipe, source inventory,
  pin/lock metadata, docs; generated kit only as contracted),
  `tests/integration/m4-independent/**`, `tests/browser/m4-independent/**`.
- **Boundary:** instantiate into an unrelated disposable game directory, customize
  title/objective, at least one platform/hazard arrangement and a material/cue via
  supported UI/MCP commands. Include two independent decoration prefab copies;
  edit one only. Keep the kit immutable and record exact engine/template identities.
  Produce reproducible sources, not merely a captured runtime snapshot.
- **Failures:** hidden engine checkout dependency, title-only clone, stale asset
  pins, first-project mutation, missing superseded sources/lockfile, engine edits
  needed to customize, local layout contaminating export.
- **Evidence / accept:** C04/C05/C08/C12; clean kit install, backend reopen, both
  host playthroughs and static export at a non-root path; source recreation hashes
  match under contracted identity normalization. Show original/template unchanged.
  **Next Gate S review.**

## 77 — Consistent backup, verification and clean restore

- **Outcome / dependency / gate:** tested operator tools preserving all source
  state without in-place overwrite / accepted S / T.
- **Read:** promoted reliability contract, workspace §15 and creation/ownership/
  external-change rules; independent game source inventory.
- **May edit:** `tools/recovery/**`, approved additive workspace public read/verify
  seam only if Q names it, `tests/integration/m4-recovery/**`,
  `tests/crash/m4-recovery*`, `docs/acceptance/m4-recovery.md`.
- **Boundary:** verify/copy a released project, include all authoritative blobs
  and independent build pins/lockfiles plus the engine kit itself (or a verified
  separately retained recoverable kit artifact), exclude live/derived state, restore same
  ID into a clean isolated root. Use public workspace open/integrity after restore;
  never copy recovery evidence over the authoritative envelope. No scheduler or
  automatic takeover. Runbook explicitly supersedes unsafe deployment §5 advice.
- **Failures:** live owner, corrupt/missing blob (including superseded versions),
  truncated/inconsistent backup, included ownership, path/symlink escape, existing
  destination, disk-full and crash at each publication boundary; valid/invalid
  external file replacement and lost-ack retry after subprocess restart.
- **Evidence / accept:** C09/C10; real files + SIGKILL; originals/previous backup
  unchanged on refusal, matching restored identities/digests, integrity all `ok`,
  no derived cache prerequisite, fresh Play/export after restore with original
  kit/checkout unavailable. A pin without retrievable kit bytes fails verification.
  Document what
  SIGKILL proves versus untested power-loss/storage guarantees. **Next 78.**

## 78 — Bounded diagnostics and actionable failure presentation

- **Outcome / dependency / gate:** owner can identify failing stage and safe next
  action through UI/MCP / 77 / T.
- **Read:** promoted diagnostic contract; existing protocol/job/query/relay shapes;
  runtime/adapter/host diagnostic exports; 70/73/77 failure records.
- **May edit:** scoped diagnostic additions in `packages/{protocol,backend,mcp-adapter}/`;
  editor status/diagnostic controls; approved public producer fields in
  runtime/three-adapter/game-host only if named at Q;
  `tests/integration/m4-diagnostics/**`, `tests/browser/m4-diagnostics/**`.
- **Boundary:** aggregate bounded summaries through existing services, with
  project/revision/build/run identity and stable codes. No raw code/credentials/
  absolute paths, hidden remote logging, auto-repair, second simulation or mutable
  diagnostic source of truth. Respect disconnected/stopped/failed states.
- **Failures:** malformed asset/template, unsupported module/behavior, blocked
  audio, no WebGL, shadow fallback, stale/expired/no-browser relay, corrupt source,
  token/path redaction and oversized/repeated failures.
- **Evidence / accept:** C07/C13/C14; real UI and stdio-MCP show matching code/
  identity, bounded redacted payloads and a workable recovery instruction; denial
  and degradation are visibly distinct from success. **Next 79.**

## 79 — Representative desktop budget and lifecycle measurements

- **Outcome / dependency / gate:** raw measured distributions against preapproved
  thresholds on the completed game / 78; approved 67-B required before scored
  measurements (candidate assembly/calibration preflight may precede it) / T.
- **Read:** accepted reliability budget table/protocol, 63 device record,
  76 independent game and 69/70/78 ownership diagnostics.
- **May edit:** `tests/evaluations/m4-performance/**`,
  `docs/acceptance/m4-performance.md`, candidate kit/pin inventories under
  `samples/m4-independent/**` and evidence only. No product optimization or changed
  thresholds in this packet.
- **Boundary:** first regenerate the kit with 75's tooling after any 78 changes,
  update only the independent game's kit pin/inventory (preserve customized source),
  repeat isolated builds/scans and record source/kit/candidate identity agreement.
  If 67-B was deferred, calibrate this representative candidate and return the
  data to its explicit target-ratification checkpoint before scoring. Then run the
  specified viewport/Play/export, cold/warm load, 20 lifecycle
  cycles and soak on exact content/engine pins. Physical hardware measurements
  cannot be replaced with SwiftShader. Identify observers, clock resolution,
  throttling, cache/network conditions and unavailable GPU/heap measurements.
- **Failures:** p95/p99 breach, catch-up drops, leak slope, warm-cache-only claim,
  model missing during measurement, hidden tab, changed content/device, noisy
  process contamination, disjoint timer or unsupported GPU query.
- **Evidence / accept:** C11/C13; raw samples, calculation script, repeated-run
  summary and PASS/FAIL/UNVERIFIED per metric. Identify at most a bounded ranked
  hotspot list for 80. Lack of hardware blocks this acceptance, not a reason to
  invent numbers. If hardware is unavailable, record C11 UNVERIFIED and exact
  missing prerequisites; 80 may take only the no-change/evidence-pending path.
  **Next 80.**

## 80 — Evidence-led reliability/performance repair and regression check

- **Outcome / dependency / gate:** bounded fixes for measured failures, or a
  documented no-change recheck / 79 / T.
- **Read:** 79 raw results/hotspot list, exact affected public contracts and owning
  tests. No speculative optimization backlog.
- **May edit:** only the specific existing producer/render/lifetime paths named
  in a written pre-edit scope table in handoff 80, within adapter/game-host/editor/
  runtime; matching tests and performance harness; kit regeneration and independent
  game pin/inventory refresh using 75's tooling only. The table must map each file
  to a measured issue. A new module, dependency, rendering profile, physics rule,
  contract change or broader subsystem repair requires a gate-approved split.
- **Boundary:** remove observed redundant work/leaks without altering scene
  quality, data formats, gameplay semantics or targets. If all budgets pass,
  implement nothing; reproduce measurements and record the no-change result.
  If required hardware was unavailable, do not optimize on guessed hotspots:
  record no change with C11 still UNVERIFIED. After any engine repair, regenerate
  kit/re-pin the release candidate without changing game sources, re-run isolated
  builds/scans, and measure that exact new identity in both development and kit
  paths. This is candidate assembly, not an automatic user-project upgrade.
- **Failures:** optimization changes collision/input/camera traces, disables media,
  prunes required module, hides diagnostics, shifts cost to startup or leaves stale
  resources. A failed target remains FAIL until measured again after repair.
- **Evidence / accept:** C11/C13; before/after raw data on identical inputs,
  semantic replay and browser visual regressions, lifecycle counters, full checks.
  **Next Gate T review**; no acceptance with unresolved required budget failures.
  T may issue an explicit hardware-only partial verdict to unblock 81's software
  evidence and 82's runbook, naming deferred 67-B/79/80 and required T/U re-review.
  This does not close C11 or permit final owner acceptance.

## 81 — Integrated template, independent-game and export acceptance

- **Outcome / dependency / gate:** complete C01–C16 software evidence, not isolated
  unit success / accepted T or its explicit hardware-only partial verdict / U.
- **Read:** all acceptance rows, 63 ledger, 69–80 handoffs, approved contracts
  governing each route, owner checklist (read-only; do not sign it).
- **May edit:** `tests/integration/m4-acceptance/**`, `tests/browser/m4-acceptance/**`,
  `docs/acceptance/m4-report.md`, evidence. Product defects go back to a bounded
  repair owned by the appropriate packet/gate; do not patch many packages here.
- **Boundary:** execute create→customize through UI/MCP→undo/reopen→hide panels→
  Play→death/checkpoint/goal/replay→backup/restore→independent clean build→static
  export. Run both actual hosts, two aspects, non-default settings, models/audio,
  two prefab copies, reimport and failed replacement. Compare matching captured
  semantics, not wall-clock pixel identity. Exercise security/failure negatives.
- **Failures:** any missing C-row, Node trace substituted for browser motion,
  source kit or export secretly accesses authoring origin, stale capture identity,
  report labels functional absence as only physical-hardware unavailability.
- **Evidence / accept:** C01–C16 with artifact IDs and environment facts; M1–M3
  regression evidence; two-tree deterministic builds; full clean-install checks.
  Carry physical/audible/owner-only claims explicitly UNVERIFIED with procedures.
  Do not promote historical M2/M3 labels by inference. **Next 82.**

## 82 — Reproducible operator runbook and final owner review pack

- **Outcome / dependency / gate:** owner can run the final checklist without
  reverse-engineering test internals / 81 / U.
- **Read:** 81 report, open debt/decision ledger, `acceptance/deployment.md`,
  `acceptance/m4-recovery.md`, `acceptance/m4-performance.md`, final owner checklist.
- **May edit:** `docs/acceptance/{deployment,m4-owner-checklist,m4-report}.md`,
  `docs/handoffs/m4-owner-review.md`, template/independent-game READMEs; verification
  launcher/docs under `tools/m4-owner/` only if needed, no new product API.
- **Boundary:** replace unsafe/stale deployment advice with one authoritative
  procedure. Supply tested copy/paste commands for install, disposable template
  workspace, two origins, MCP, static non-root export, backup/restore and budget
  runner. Use placeholders/environment injection for secrets; no real credentials
  in files. Cite kit/template/build/content identities and every open decision.
  Do not deploy, restart live services or sign the owner's checklist.
- **Failures:** untested launch commands, hidden local paths/dependencies, live
  project used for destructive drills, instructions requiring undefined admin
  access, claims of independent/owner approval without an actual record.
- **Evidence / accept:** C15/C16; replay documented commands in a fresh disposable
  directory, attach logs and actual URLs, mark physical/manual rows awaiting owner.
  Handoff distinguishes implementation complete, architectural gate verdict and
  final owner acceptance. **Next Gate U review, then owner checklist; STOP.**
  Later feature/milestone planning requires a separate owner request.
