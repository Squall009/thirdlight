# M4 execution checkpoint (durable)

Updated after: **Packet 69 DONE (2026-09-22)** — the three-adapter
`models` block (C64-4) implemented + unit-tested (109/109 in the package),
with real-loader Node evidence + real-browser visible-model/pose/jump/
dispose-cycle evidence (15/15 rows PASS ×2 runs; `npm test` 180 files/
2255 green). In-scope settle-race defect repaired (+ regression test);
out-of-boundary defect discovered + refiled: the committed template/sample
`courier.glb` (digest `d62fc659…`) carries corrupt animation data (root
cause in `samples/beacon-reach/tools/generate-assets.mjs` — the sampler
input accessor index `tAcc = 3 + samplers.length * 2` miswires; refiled to
the sample/template packets 72–74). Handoff `docs/handoffs/69.md`; STATUS
row 69 done. **Current state: packet 70** (Both production hosts —
70-A both game wrappers / 70-B authoring viewport; per the standing
authorization). **Owner standing authorization (2026-09-22): "continue
until all of M4 is implemented — do not stop until it is finished" (64–82
+ Gates Q–U; per-packet handoffs/STATUS rows still mandatory).**

## Packet 69 final state
- `packages/three-adapter/src/`: `models.ts` (new — `SceneAdapterModels`
  assets/animation/resolveBytes; `validateModelsBlock`; `createModelsRealization`
  two-phase prepare (wrapper-verified bytes → real-`byteLength` descriptor
  → `store.load`; the adapter never re-hashes); per-instance
  `cloneInstanceMaterials` (clones share the resource-owned textures); one
  `createVisualResourceStore()` per adapter), `adapter.ts` (`models?`/
  `modelsLoader?` options — the root subpath stays loader-free; the
  loader-free-ness keeps the M1/M2 bundle-graph §5.4.1 counts;
  `modelsSettled()`; diagnostics `models` counters; renderFrame = transform
  sync → advance live controllers once with a clamped `[0,0.25]` delta →
  render (C13); `viewFor`: player = committed `playerMotion`, non-player
  model entities = constant neutral `{speed:0, grounded:true}` ⇒ idle;
  fail-fast `models_config_invalid` for models-without-loader / non-v3),
  `errors.ts` (`models_config_invalid`, `models_asset_unresolved`),
  `index.ts` exports, `models.test.ts` 18 tests.
- **Settle race (repaired in-scope):** `settleIfComplete` gated on
  `handle.state() === 'pending'` — the microtask gap between promise
  resolution and the attach `.then` made it settle early (observed
  `{instances:4, animations:0}` vs counters `{6,2}`). Explicit `pendingCount`
  decremented inside each completion callback before settle; the 0-byte
  discard path decrements too. Regression: two-asset microtask race.
- **Refiled defect (out-of-boundary):** `samples/beacon-reach/assets/model/
  courier.glb` + `fixtures/m4/templates/…/sources/model/courier.glb` (byte-
  identical; digest `d62fc659f569b42c0f828ebf08eac661b5afe4312f81266a178ea3d3e25678be`)
  — corrupt animation data (clip key times = box vertex indices 0..7; 79
  non-monotonic transitions of 179/track) → `asset_clip_invalid`. Root
  cause: `generate-assets.mjs` `buildRigidModel` `tAcc = 3 + samplers.length
  * 2`. Latent in M3 (sample courier static-only; the template recipe cmds
  27–30 bind the clips). `beacon.glb` static ⇒ valid. **69 evidence uses
  packet-owned GLB bytes** (`tests/integration/m4-render/fixtures/sources/`;
  `tools/glb-build.mts` — deterministic; self-checked through the real
  pinned GLTFLoader; same assetIds + clip names/order Idle/Run/Airborne +
  4.0 s) recorded in the fixture index `sourceSubstitution` block. **70/
  72–74 will meet the defect again in template instantiation evidence —
  the refile stands until the sample/template packets repair it.**
- Fixture: `tests/integration/m4-render/` — `tools/generate-fixtures.mts`
  (replays the template 30-command recipe through the real commands engine
  + ONE documented deterministic DATA TRANSFORMATION: `group-0001` gains
  `model` + `modelAnimation` — (controller+model) is unreachable via the
  accepted command set (setComponent model edit-only; second controller
  rejected; `game.playerId` must name the existing controller) while the v3
  validator accepts the combination and §2.4 defines it; gated by
  `validateSceneV3`; 20 entities rev 31; `--check` byte-identity) +
  `probes/render-entry.ts` (in-page: real GLB fetch + WebCrypto sha256 vs
  index, real `createPhysicsPort` (replicated `physicsConfigFromSnapshot`),
  `instantiateRuntime` with BUILTIN_MODULES + platformerSpec +
  platformerGameSessionSpec + platformerGameCameraSpec, a BASE-RELATIVE
  `ActionSource` (neutral until the first `playing` view — the simulation
  steps during `awaitingStart` and Node-side timers overshoot under the
  headless Chrome's CPU contention; the evidence window is anchored
  page-side to the simulation timeline), `runtime.gameCommand('start')`
  queued after the models settle, `createSceneAdapter` + the `models` block
  + `createGltfLoaderPort()`, rAF live-set instrumentation incl.
  `cancelAnimationFrame` interception, `__tl69` API: settleResult/state/
  frames/rafStats/disposeCycle) + `run.mts` (15 rows: R01–R02 fixture;
  R11–R15 Node real loader/real mixer — settle, counters, dispose
  baseline, L6 wrong-clip, L4/L5 unresolved; R21–R28 real browser —
  settle, 8 visible PNGs, frames change, two instances at distinct
  committed states (player `run` + `airborne` y≈1.97 over the hazard;
  non-player `idle`), full trajectory (run ≈4 m/s, two full-hold jumps
  clearing the step-block x∈[6,7] and the hazard x∈[10.5,11.3], clean
  stop x≈14.27, no death), C13 rAF peak 1, 3× dispose cycles at baseline,
  0 external origins).
- **Engine facts of record (verified this packet):** the entity transform
  is the capsule CENTER (the physics port places the capsule collider
  centered on `config.character` — the character rests at y=0.91 on the
  ground top 0.0); the controller's variable-height rule (F) halves vy AND
  clears the `airborne` flag on a `released` edge while ascending — an
  early release both shortens the flight and suppresses the committed
  `airborne` role (the recorded input holds each jump through the apex);
  the simulation steps during `awaitingStart` (the session gate governs
  game state, not the step loop); `getGameView()` returns the `{ok, view}`
  wrapper; `createRecordedActionSource.sample` is an EXACT stepIndex lookup
  (neutral otherwise); `GameSession` T1: `start` only in `awaitingStart`,
  consumed at the step boundary after the accepted 12-step settle
  pre-roll; motion starts at ≈ start+17.
- Evidence: `docs/acceptance/evidence-m4/69/raw/` (summary.json, node-
  phase.json, browser-phase.json, 8 browser-frame PNGs, probe.js).
- UNVERIFIED: hardware-GPU rendering (SwiftShader only), real
  keyboard/gamepad/audio (no physical devices; the probe drives the
  engine-level ActionSource seam; D-63-2 owned by 70).
- No lockfile/contract/other-package change; no commit.

## Packet 68 final state
- The review pack (all PROPOSED; no accepted contract/product/lockfile
  changed):
  - `docs/planning/m4-contracts/contract-diffs.md` — the COMPLETE inventory
    (26 rows: 64 ×8, 65 ×10, 66 ×3, 67 ×5; 11 no-change adjudications + 1
    replacement proposal; each with author/destination/fixture/consumer/
    version-graph effect/status; totals: 38 new codes, 0 new deps/pins,
    1 manifest combination, 1 graph subpath, 3 tooling edges, 2 routes +
    3 MCP rows) + the fixture→checker map + the debt-ledger dispositions +
    the 10-item cross-pack reconciliation + the 8-item PENDING OWNER docket
    (K-3, behavior scope/CCR-65-1, CC-55-3b, device, relay ownership + §18,
    origin value, CCR-66-1, C64-5) + the Gate Q protocol (model review ≠
    owner approval; explicit docs-only promotion via gate-q.md; 69 waits
    for the owner's go).
  - `docs/planning/m4-contracts/traceability.md` — the 7-hop template chain
    (field→command→UI/MCP→storage→module closure→both hosts→acceptance with
    owners) + the chain invariants (the 8 packet failure modes) + the
    C01–C16 owner table (every row has implementation/evidence owners) +
    the separate-records rule.
  - `fixtures/m4/audit/` — the audit runner (`tools/audit.mjs`, any failure
    exits nonzero) + `cases/error-code-registry.json` (38 new codes: 16
    templates / 8 distribution / 14 reliability / 0 delivery; the meaning
    notes for the deliberately distinct path-escape codes) + README. **
    VERIFIED EXIT 0 (2026-09-22):** A — 4/4 checkers green; B — 4/4
    deliberately corrupted edges exit nonzero (B1 the module edge, B2 the
    destination identity, B3 the kit digest, B4 the backup/scene inventory
    — in-place tamper + regenerate-and-recheck green); C — the registry
    consistent (set-equality per proposal section; no code in two sections;
    delivery reuse-only — the contradictory-errors check). `npm test`
    179/2237 green.
  - `docs/decisions/0004-m4-reliability-and-templates.md` — PROPOSED only
    (the 11-section decision record; not binding until the Gate Q record).
- **Gate Q state:** CLOSED 2026-09-22 — the in-session model review of the
  pack is complete, the docket is ruled (conservative defaults; owner may
  amend), and the promotion is applied + recorded
  (`handoffs/m4-promotion.md`). Packet 69 proceeds under the standing
  authorization.

## Packet 67 final state
- Contract proposal: `docs/planning/m4-contracts/reliability.md` (Gate Q).
  **67-A:** consistent backup = the accepted workspace §15 included set
  (manifest + envelope + every sources/sha256 blob incl. superseded; the
  excluded classes never restored); live-owner refusal before any copy
  (backup_live_project — the accepted §6.2 liveness test); the new
  backup-manifest.json (inventory + inventoryDigest + per-project digests/
  revision/template provenance — the C10 provenance) written LAST (no valid
  manifest = backup_incomplete, never a backup); ordered read-only verify
  (truncated / bad hash / missing-or-superseded blob / ownership-included /
  path-escape; orphan blobs included + informational); retention MANUAL
  (declared — no silent pruning). Same-ID restore (verified, EMPTY same-id
  destination, identity before first write) vs new-ID creation (the exact
  3-field identity rewrite, revision preserved — a copy, not a migration
  reset) pinned as DISTINCT. Diagnostic report: GET /api/v1/admin/health +
  admin MCP row tl_health (≤ 32 KiB, 100/32 list bounds — the accepted
  scan/ring values re-used; redaction by typed envelope; overflow clips +
  truncated:true; backendId+ts+engineVersion point-in-time identity, re-
  fetch on change; asserts nothing about hardware). Fault matrix F1–F8
  (accepted machinery + 65 template phases + 66 kit re-hash + 67 backup/
  restore crashes) under the no-ready-partial (C09) invariant.
  **67-B protocol-only:** named device BLOCKED (owner pending — the
  reference-device §2 proposal); 3 digest-frozen scenes (S1 committed v3
  envelope, S2 committed Beacon Reach capture, S3 template starter final
  scene = deterministic recipe replay); measurement protocol (environment
  record incl. GL_RENDERER + warm-cache condition; 10-min warmup; N ≥ 30;
  median + p95; 7 closed metrics; no-early-box-data); every threshold row
  BLOCKED — unmeasured (never invented); ratification checkpoint
  `handoffs/67-budget-ratification.md` (79 preflight allowed after 76/78,
  NO scored run until target review/promotion + owner confirmation).
- Owned diffs (PROPOSED): `diffs/workspace.md` (C67-1 no change — the tools
  execute the accepted §15 classification offline), `diffs/sessions.md`
  (C67-2 the admin health route + tl_health MCP row + the bound rows),
  `diffs/runtime.md` (C67-3 no change — the report aggregates the accepted
  §8 diagnostics), `diffs/dependencies.md` (C67-4 no new package/dependency
  — plain-Node tooling edge), `diffs/deployment.md` (NEW: C67-5 the §5
  REPLACEMENT proposal — the raw whole-tree tar that copies the §15-excluded
  classes + carries no verification is replaced by the inventory-based,
  verified procedure; the takeover note preserved).
- Fixtures: `fixtures/m4/reliability/` (6 case files + index + generator
  (`npx tsx generate-fixtures.mts`, --check) + INDEPENDENT checker
  (`check-reliability.mts`)). The checker EXECUTES all 8 refusal cases
  (R1–R8) through its own REFERENCE implementation of the §1–§2 procedures
  against temp trees — each asserting the exact code AND the originals
  byte-identical after the refusal (the acceptance obligation; the R8 live-
  owner leg uses the checker's own live pid, the dead-owner leg a real
  exited pid) — plus positive restore/create legs; re-derives the backup
  example + the 3-field transform byte-exactly; re-derives S3 by a second
  independent engine replay (generator/checker agree); asserts every
  threshold row is BLOCKED. All green; tampered-digest negative control
  exit 1 (2 detections); `npm test` 179/2237 green.
- CCRs: CCR-67-1 (the backup/restore/budget tools ship with the packet-75/
  79 tooling — the fixture reference implementation proves the spec, not the
  product), CCR-67-2 (independent non-performance work proceeds while 67-B
  awaits hardware — the reference-device §3 record re-affirmed).
- No product source, no accepted contract, no lockfile changed (docs +
  fixtures only — the 67 may-edit scope).

## Packet 66 final state
- Contract proposal: `docs/planning/m4-contracts/distribution.md` (Gate Q).
  Key design: the kit = a local, integrity-indexed distribution of the
  EXISTING workspace (closed allowlist — 3 root manifests + exact lockfile
  bytes + 370 unit source files + 8 tooling + 9 contracts + 11 template
  files + 2 generated data files = 403 rows; negative inventory: no
  node_modules/dist/.git/fixtures/samples/top-level-tests/symlinks). Identity
  = digests, never a fabricated tag/version: engineRef `working-tree` (a
  dirty tree is never identified by a commit alone) or `commit` (supplementary);
  `kitDigest` = block digest over the allowlisted source files only (the
  generated data embeds the digest ⇒ inventoried, not a digest input);
  engineVersion stays 0.1.0. node_modules never vendored (25 machine-
  dependent @esbuild/<platform> packages) — install = `npm ci --prefix <kit>`
  (lockfile-authoritative ⇒ transitive floating dep impossible by
  construction; registry-down = structured `kit_install_unavailable`). C12
  boundary exact (browser runtime three/react-editor-only/rapier; node
  runtime ws+MCP-SDK; esbuild = build-only-at-runtime EXTERNAL in the
  backend bundle; typescript/vitest dev/test-only). Game owns `game.json`
  (template provenance + enginePin + documented build entry); the vendored
  kit is immutable (re-hashed before every build); upgrade = explicit
  second-kit + re-pin. The public Node build tool `tools/game-build.mjs`
  (plain node:* — the NEW tooling unit edge, CCR-66-2): 8 ordered steps
  (resolve-from-own-location (never process.cwd()) → verify-kit → verify-pin
  → npm ci → npm run build (the accepted pipeline) → verified template
  install → export through the ACCEPTED admin export route (kit backend,
  THIRDLIGHT_ENGINE_ROOT=<kit>) → verify the static closure). Licenses:
  UNLICENSED/private ⇒ owner-local only, no grant, no publish; required
  NOTICE with the lockfile-extracted license names. Owned diffs: C66-1
  dependencies (no new package/dep/pin/lockfile change), C66-2 export (no
  change — the accepted admin export route is the build entry; the kit
  satisfies THIRDLIGHT_ENGINE_ROOT by shape; scans unchanged), C66-3
  workspace (no change — the game project = a plain workspace instance under
  the game data root; the 65 operator runs against the kit templates/ set).
  CCRs: CCR-66-1 (contracts evidence-path exemption — documentation text,
  never resolved; digests still bind), CCR-66-2 (the kit assembler +
  game-build tool ship with the packet-75 tooling).
- Fixtures: `fixtures/m4/distribution/` (6 data files + generator +
  INDEPENDENT checker + README): the 403-row inventory (re-derived from the
  live tree by both tools), the working-tree identity, the 9-pin license
  inventory (from the lockfile), 7 pin cases, the 8-step build-tool order +
  rules + 8 negative-inventory cases. Checker green (26 sections); its first
  run caught 3 real checker defects (path depth, an over-matching negative-
  inventory regex — unit test dirs are unit SOURCE and are inventory
  members, and an index byteLength computed from string length instead of
  UTF-8 bytes) — all fixed; tampered-fixture negative control exit 1
  (2 independent detections); generator --check byte-identical.
- Tree note: `packages/workspace/node_modules/.vite/` (a vitest cache —
  harness residue, regenerated by test runs) is excluded from the kit by
  rule (noted by the checker, not a defect).
- No product source, no accepted contract, no lockfile changed (docs +
  fixtures only — the 66 may-edit scope).

## Packet 65 final state
- Contract proposal: `docs/planning/m4-contracts/templates.md` (Gate Q).
  Key design: ONE versioned built-in template (`platformer-starter`),
  directory form (descriptor + base scene + recipe + sources + NOTICE),
  three independent digest checks, no archives/symlinks/scripts. Creation
  operator `createProjectFromTemplate` with 5 phases (reserved → blobs →
  envelope → replayed → published), atomic-mkdir reservation, marker
  (`.thirdlight/reservation.json`), full crash-completion table; partial
  destinations are NOT projects (refused as
  `template_initialization_incomplete`). Starter content replays through
  the SAME command engine (30 commands, deterministic `req-<sha256-32hex>`
  requestIds per the accepted `^req-[0-9a-f]{32}$` shape; N ≤ 128 bound =
  the retry retention). Manifest `schemaVersion 2` + required `template`
  block (the named bump: only (2,3,3) valid; migration never re-versions —
  the accepted rule unchanged; plain createProject still writes v1).
  Finite M4 module registry (3 platformer core + demo + behavior-ref
  pattern); resolution at create/capture/build/post-edit; layout/panel
  state NEVER an input (C06). Panel-visibility preferences: frozen 7-panel
  registry, browser-local per-project localStorage, template seed,
  corruption ⇒ safe reset; byte-absent from envelope/snapshot/export/backup.
  Origin kind `template` PROPOSED (C65-7) — pre-promotion the accepted
  engine rejects it (verified live: `invalid_request /origin/kind`), so the
  fixture replay uses the documented `admin` substitution (audit tag only).
- Owned diffs (PROPOSED): `diffs/project-model.md` (new: C65-1/2 manifest
  v2 + manifest_storage_mismatch), `diffs/workspace.md` (new: C65-3/4/5 the
  operator + scan + 11 new codes + no-new-artifact-class adjudication),
  `diffs/commands.md` (C65-9 no-change adjudication — the recipe uses only
  accepted ops; queryProject carries the v2 manifest with no shape change),
  `diffs/sessions.md` (C65-6/7 the admin route + permission rule + MCP tool
  rows + the origin kind), `diffs/dependencies.md` (C65-8 no-change
  adjudication — no new package/dep/bundle; templates/ = engine data).
- Fixtures: `fixtures/m4/templates/` — the complete template (7 blobs =
  the committed self-generated sample bytes; recipe = the accepted 26
  Beacon Reach commands + 4 additions: courier modelAnimation Idle/Run/
  Airborne @ 0/1/2, createPrefab, TWO independent instantiatePrefab
  instances — closes Gate P F4/B17 + visible animated content), 5 case
  files, index.json; committed generator (plain node, --check) +
  INDEPENDENT checker (`npx tsx check-fixtures.mts`) that replays the full
  recipe through the REAL @thirdlight/commands engine (the accepted
  capture-tool pattern) and asserts the end state + validateProjectV3.
  Checker green; corruption negative control exit 1; generator --check
  byte-identical.
- Engine facts of record (verified this packet): the engine stores
  `content.settings` in CANONICAL ALPHABETICAL order (distinct from the
  §21.4 registry-table order the 64 querySettings proposal uses); the
  accepted origin validation is exactly browser|mcp|admin; the requestId
  shape is exactly `^req-[0-9a-f]{32}$`;
  `validateProjectV3(manifest, scene, content)` is the public v3
  composition validator.
- CCRs: CCR-65-1 (keep the built-in-only behavior refusal vs open linking —
  Q decision; CC-55-3a stays deferred), CCR-65-2 (exact-match template
  engine-version rule — proposed inert at 0.1.0).
- No product source, no accepted contract, no lockfile changed (docs +
  fixtures only — the 65 may-edit scope).

## Packet 64 final state
- Contract proposal: `docs/planning/m4-contracts/delivery.md` (Gate Q).
  Key framing discovery: **most of the 63 "contract gaps" are implementation
  gaps against ALREADY-ACCEPTED text** — runtime.md §2 already mandates the
  v3 `game` field on snapshot documents (D-63-9 = backend/protocol/bridge
  implementation gap, no contract change); sessions.md §13.4/§17.6/§10.2/§5.2
  already mandate the bridge repairs (D-63-4/5/6/7 = implementation, no
  contract change). True contract additions (owned diff rows in
  `docs/planning/m4-contracts/diffs/`):
  - C64-1 commands.md §2/§3.1/§5.6: new `querySettings` op (explicit +
    resolved settings maps, registry order, revision carried; v1 ⇒ both {};
    the ONLY source of settings values; kills the default-based fallback).
  - C64-2 commands.md §5.6: normative count semantics for the accepted
    `queryProject` content summary (P2-B; implementation returns no content
    field at all — verified session.ts:2192–2208).
  - C64-3 presentation.md §41.3.6: rule-7 clarification (static model, run
    proceeds; "does not run gameplay" = the role selector) + non-player
    entities pin the neutral motion ⇒ idle.
  - C64-4 presentation.md §41.9: the `createSceneAdapter` `models` block
    (resolved assets + media.animation + resolveBytes) +
    `models_config_invalid`/`models_asset_unresolved` codes +
    `SceneAdapterDiagnostics.models` counters.
  - C64-5 export.md §5.2: M3 entry row correction (accepted text names
    `export-bootstrap-m2.ts`; the accepted implementation is
    `export-bootstrap-m3.ts`, `M3_EXPORTER_FILES` graph.ts:107) — owner scope
    decision at Q.
  - C64-6 dependencies.md §4.2: M3 preview/export bundle graphs gain the
    `three-adapter` `./gltf-loader` subpath (the §5.4.1 GLTFLoader row
    applies; M1/M2 bundles stay loader-free; editor bundle only via 70-B).
  - C64-7 runtime.md + C64-8 sessions.md: no-change adjudication records
    (the binding citations fixed so 70/71 implement to accepted text).
- Design of record (delivery.md §2): model bytes flow wrapper→host-config/
  adapter (no fetch in host/adapter); the adapter owns the visual resource
  store + model prepares + role controllers behind the UNCHANGED
  `HostRenderAdapter` surface (host stays model-agnostic — zero host changes
  for model attachment); single loop: host hostFrame → adapter.renderFrame =
  sync transforms → one `update(delta)` per live controller (view = committed
  GameView; non-player ⇒ constant neutral motion) → render. Model root is a
  CHILD of the entity holder (runtime moves the holder; mixer writes only
  weights/time — no physics-root animation writes). Corrupt = hard mount
  failure (L1–L5 table, closed codes); degraded = accepted capability states
  (no-WebGL page, audio blocked, L6 static+diagnostic). Pinned reimport is a
  no-op for the active play (new snapshotId/contentId only).
- Fixtures: `fixtures/m4/delivery/` (5 GLBs incl. corrupt/undeclared
  negatives; 4 case files; index.json; committed generator + independent
  checker, no deps/eval/network/three). Checker re-derives GLB facts, index
  digests, manifest-fragment digest identity + ready tuple, selector/
  crossfade math, query maps, the committed v3 fixture summary (re-derived
  from fixtures/m3/storage/project-v3-demo-0003/scenes/main.json — note:
  that file is the FULL v3 envelope with keys content/projectId/retry/scene/
  storageVersion/type), closed-code membership. Negative control verified:
  temp copy + flipped byte ⇒ checker exit 1 (3 independent detections).
- Commands: generator (write + --check byte-identical), checker OK, negative
  control exit 1, `npm test` (full) — see handoff 64.
- No product source, no accepted contract, no lockfile changed (docs +
  fixtures only — the 64 may-edit scope).

## Packet 63 final state (superseded where packet 64 refined the framing)
- Probe suite: `tests/evaluations/m4-baseline/` (run.mts orchestrator with
  `TL_M463_EVIDENCE_DIR/TL_M463_PHASES/TL_M463_NO_BUILD`; phases-ab.mts;
  phase-c.mts with bridge transcript + control probes + session logs;
  lib/frames.mjs; probes/composition-entry.ts).
- Canonical evidence: `docs/acceptance/evidence-m4/63/raw/` (22 files;
  final run 2026-09-22T05:16Z, EXIT 0). Row matrix: A01/A03/A06–A10,
  B00/B01/B01b/B03/B04, C01–C05, C11, C12 PASS; A02/A04/A11, B02/B05,
  C03b/C13 INFO; A05/B04b/C08–C10 UNVERIFIED; **C06/C07 FAIL**.
- Contract docs (new): `docs/planning/m4-contracts/{debt-ledger,baseline,
  reference-device}.md`.
- Handoff: `docs/handoffs/63.md`; STATUS rows 62 (corrected, SD-63-2) + 63
  (done).
- Defect chain for v3 Play (all captured, none repaired): D-63-5 (v3 wrapper
  `preview-m3.ts:272–276` never acks the handshake — editor `App.tsx:570`
  gates the snapshot on the ack), D-63-6 (`preview-m3.ts:289` `tl.ready`
  body fails §13.5 validator: empty contentDigest), D-63-4 (+merged D-63-3:
  editor WS client has zero `.send(` ⇒ no §5.2 heartbeat, no
  `play.preview.ready` ⇒ 15 s `preview_timeout` every run — sessionLog
  proven), D-63-9 (4-key runtime.md §2 snapshot document cannot carry the
  `content.game` block: `snapshot.ts:173` absent→null, `runtime.ts:593`
  `config_invalid`/`game_config`, `host.ts:451` fail-closed), D-63-2 (canvas
  no tabindex as shipped), D-63-7 (`client.ts:447–459` drops `playContent`,
  masked by `App.tsx:315–317`), D-63-8 (export HUD one-shot refresh).
  M3 carry-forward: CC-55-3 split a (behavior-linking, Gate N accepted open;
  code truth `host.ts:480`/`content-closure.ts:506`) / b (HUD wording diff);
  K-3 names recorded; P2-B re-verified (queryProject omits `content`);
  M3-GLB captured (packet 69).
- CCRs: CCR-63-1 (snapshot doc + `tl.snapshot` allowlist gain `content.game`
  for v3 — **refined by packet 64**: runtime.md §2 ALREADY mandates `game`
  on v3 snapshots, so this is an implementation repair, not a contract
  change), CCR-63-2 (v3 wrapper bridge behavior vs sessions.md §13.4/§17.2.1
  — likewise no-change adjudication), CC-55-3a/b owner decisions at Gate Q.
- Harness lessons of record: (1) the m3-browser `browser.close()` must run in
  `finally` — an early `return` skips it and the orphaned Chrome's editor
  client re-establishes to the next run's backend on the same ports → 409
  `session_conflict` storm (fixed; verified 0 orphans after runs); (2) use
  self-safe pkill/pgrep patterns (`[c]hrome` bracket trick) — a literal
  pattern matches the invoking shell; (3) CDP `Network.getResponseBody` on
  the captured `/play` requestId yields the real buildId/contentId; (4)
  `Window.prototype.postMessage` wraps do NOT capture cross-origin
  `iframe.contentWindow.postMessage` (raw `message` listeners do — use those).

## Prior state (pre-63)
- Plan review: ACCEPTED WITH BOUNDED FOLLOW-UPS PR-M4-1…PR-M4-6
  (`docs/handoffs/m4-plan-review.md`); PR-M4-1 applied to
  `docs/planning/m4-packets.md`; execution authorization recorded separately.
- STATUS.md: M4 execution section added (gate table Q–U + rows 63–82 pending).
- Gate state: all Q–U pending. No commit made (owner rule: no commits in M4
  execution — the dirty M2/M3 tree stays the baseline).
- Current state: **Gate Q** (the owner's gate — the docket is inventoried
  in `contract-diffs.md` §5; packet 69 follows on the owner's go).

## Baseline facts (verified 2026-09-21)
- Working tree: 363 changed paths (257 untracked / 106 modified) = M2/M3 work.
- Toolchain: node v22.22.1, npm 9.2.0; pins three 0.186.0, esbuild 0.28.2,
  typescript 5.9.3, vitest 5.0.1, ws 8.21.3, rapier2d-compat 0.20.0.
- Browser: real headless Chrome for Testing via
  `tests/evaluations/m3-browser/` runner (SwiftShader WebGL 2; no physical
  devices; no display). `npm test` does not run browser probes.
- Export wiring: backend admin route builds `ExportContext` with
  `engineRoot` = checkout; `exportProjectM3(ctx, captured, entry, compiler)`.
- Workspace: `openWorkspaceService({root,...})`; `readCapturedV3(projectId)`
  seam exists (packet 58).
- CC-55-3 source truth: `game-host/src/host.ts:462–480` (fail-closed on
  behavior components) + `exporter/src/content-closure.ts:443–506`
  (`behaviors_unsupported`).
- K-3 actual surface: `platformer-game/src/index.ts` (recorded in plan review).

## Changed files so far (this task)
- docs/handoffs/m4-plan-review.md (new)
- docs/handoffs/m4-execution-checkpoint.md (new, this file)
- docs/planning/m4-packets.md (PR-M4-1 bullet)
- docs/STATUS.md (M4 execution section + header)
- tests/evaluations/m4-baseline/run.mts (new — orchestrator: env/toolchain
  record, capability table, phases A/B/C, summary + evidence index; hard
  exit + active-handle report at the end)
- tests/evaluations/m4-baseline/phases-ab.mts (new — Phase A standalone-export
  probe; Phase B production-composition probe)
- tests/evaluations/m4-baseline/phase-c.mts (new — real backend + real editor
  page + real Play preview; CDP Network status capture on failure)
- tests/evaluations/m4-baseline/lib/frames.mjs (new — cross-origin frame
  context eval via executionContextCreated; ignores destroyed contexts;
  `evalInFrame` re-resolves on navigation)
- tests/evaluations/m4-baseline/probes/composition-entry.ts (new — in-page
  production composition with `window.__tl` diagnostics)

## Packet 63 probe status (last complete run, 2026-09-21 19:07 UTC)
- Phase A (standalone export, real browser): A01 title, A03 start, A06 rAF,
  A07 wav decode, A08 two aspects (16:9 vs 4:3 render differently), A09 no
  external requests, A10 clean console — PASS. A05 scripted-motion UNVERIFIED
  (canvas byte-identical under SwiftShader; motion proven instead via Phase B
  simulation state). A02/A04/A11 recorded INFO (no tabindex as shipped;
  wrapper HUD stale after mount; 3 GLB model entities render empty).
- Phase B (production composition, real browser): B00 mount, B01 sim steps
  advance idle, B01b canvas renders, B03 Enter starts run (awaitingStart →
  playing), **B04 held-KeyD moves the player in real runtime state (PASS,
  x-delta recorded)** — this closes the packet-62 B05 gap. B04b canvas
  reflection UNVERIFIED (identical captures, SwiftShader). B02 INFO confirms
  as-shipped keyboard focus defect (canvas without tabindex cannot receive
  the canvas-scoped keydown owner) — candidate D-63-2. B05 diagnostics INFO
  (audio pre-gesture blocked by contract; audibility UNVERIFIED).
- Phase C: C01 real backend starts (env-var contract: THIRDLIGHT_* +
  `THIRDLIGHT_TOKENS=authoring:<projectId>:<token>,admin:<token>`; ready line
  `listening (authoring port …)` on stderr). Seeding the committed captured
  envelope as a loadable v3 project works: the loadable envelope is the
  captured scene+content with the `retry` block in the canonical key order
  `storageVersion,type,projectId,scene,content,retry` (envelope.ts §4.4,
  trailing LF; the captured `recipe` key is not part of the loadable doc) —
  verified via public `openWorkspaceService().query({op:'queryProject'})`
  and via the real editor (C02 loaded, C03 viewport renders, C04 Play button
  enabled; status bar `conn: connected … revision 26`).
- OPEN (last instrumented run crashed before summary; scratch evidence
  deleted — regenerates on the final run):
  1. C05: after clicking real Play, the preview iframe never got a src.
     Earlier run: POST `/play` → 409 `session_conflict` (an active authoring
     session already exists — the client's reconnect re-establish race with
     the Play POST); latest instrumented run: session 200 + four commands
     200, but the `/play` POST never completed/appeared in captured responses.
     Next step: re-run, inspect `c-05-play-failure.json` (`apiResponses` now
     includes per-URL statuses) and the client's `playStart` error path.
  2. A harness tsx crash leaks its headless Chrome (orphan reaped manually at
     the stop point); run under `timeout` and re-check orphans after crashes.
  3. `ACTIVE_HANDLES(5)` after a clean run: 4 sockets + 1 ChildProcess stay
     registered (backend child exit not awaited) — cosmetic; the orchestrator
     exits via the diagnostic timer.

## Unresolved findings
- Packet 63 C05 (in progress): real Play flow — preview iframe never receives
  a src after clicking Play (see “Exact next action” for the two observed
  failure modes). Phases A/B are green as recorded above.
- PR-M4-2 (65), PR-M4-3 (63), PR-M4-4/5/6 (guidance) per plan review.

## Exact next action (resuming packet 63)
1. Re-run `npx tsx tests/evaluations/m4-baseline/run.mts` (default evidence
   dir `docs/acceptance/evidence-m4/63/raw`); fix C05 Play-POST failure using
   `c-05-play-failure.json` (409 session_conflict vs incomplete POST —
   candidate causes: editor client re-establish race; `playStart` throwing
   before the POST; check `packages/editor/src/session/client.ts:570` and
   backend `backend.ts:774` conflict semantics; the probe may need to wait
   for `conn: connected` + stable session before clicking Play).
2. Complete C06–C12 (preview host mount, canvas render, keyboard as-shipped
   + tabindex-shim, motion, network/console).
3. Write `planning/m4-contracts/{debt-ledger,baseline,reference-device}.md`
   (split CC-55-3 into the behavior-linking ID + a separate HUD-wording ID;
   record K-3 names, P2-B, D-63-2 keyboard-focus defect, model-attach/motion
   capture gaps, deployment.md §5 copy conflict, stale STATUS row 62).
4. Handoff `docs/handoffs/63.md` + STATUS row 63. Then packet 64.

## Rules of record
- One session, no spawn_session/subsession; no commits/pushes; no live
  user-project edits; disposable instances on separate ports; no credentials
  in artifacts; hardware-dependent rows stay UNVERIFIED (owner annex).