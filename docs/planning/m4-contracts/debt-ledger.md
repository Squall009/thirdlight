# M4 carry-forward debt ledger (packet 63)

Basis: the packet-63 baseline audit (2026-09-22, node v22.22.1, real headless
Chrome via `tests/evaluations/m3-browser/`, SwiftShader WebGL2, no physical
input/audio/display devices). Working tree: the uncommitted M2/M3 set (363
changed paths) is the baseline; HEAD `5b746ee` alone is historical. Evidence:
`docs/acceptance/evidence-m4/63/raw/` (`summary.json` row matrix + raw
probes). Every row below carries **source / evidence / status / owner /
proposed disposition**. Stale-document items are kept separate from real
defects. Nothing here is repaired by packet 63 (capture only).

## 1. M3 carry-forward reconciliations

### CC-55-3 — split into two distinct items (same ID used for two matters)

The Gate N and Gate P records use the single ID `CC-55-3` for **two different
matters**; neither record is authoritative by recency — the code is the
behavior truth and both doc records stand as written until an owner
reconciles them.

**CC-55-3a — no behavior-linking channel (accepted as open at Gate N).**
- *Source (record):* `docs/handoffs/gate-n.md:196` — “CC-55-3 (open): no
  behavior-linking channel in the §3.1 config — ACCEPTED AS OPEN (not
  implemented). The 55 composition rejects behavior-carrying scenes
  fail-closed (`host_config_invalid`/`behaviors`); the concrete config diff
  is filed by 56/59 if a delivered game carries behavior records.”
- *Source (code truth):* `packages/game-host/src/host.ts:480` (fail-closed
  `host_config_invalid`/reason `behaviors`, message cites CC-55-3) and
  `packages/exporter/src/content-closure.ts:506` (`behaviors_unsupported`).
  Both paths are live in the baseline build and were exercised by the packet
  60/61 fail-closed evidence.
- *Status:* open by decision (Gate N); behavior-carrying scenes are rejected
  fail-closed in both hosts.
- *Owner/checkpoint:* owner scope decision at the next gate (Gate Q packet 68
  inventory; behavior work is packet 69 territory).
- *Proposed disposition:* keep the ID for the behavior-linking gap only;
  restate the Gate N acceptance verbatim at Gate Q so the record chain is
  unambiguous; do **not** close on the wording item’s progress.

**CC-55-3b — packet-55 HUD/status wording diff.**
- *Source (record):* `docs/handoffs/gate-p.md:113` and
  `docs/handoffs/62.md:110` — “CC-55-3 (the packet-55 HUD/status wording
  diff) remains open, carried through Gates N/O/P, awaiting an explicit owner
  scope decision; it does not block any gameplay/durability/security/export
  row.”
- *Source (code):* the export/preview HUD wording surfaces
  (`packages/exporter/src/export-bootstrap-m3.ts:224` one-shot HUD line;
  game-host status projection) — the two records describe a wording delta,
  not a behavior delta.
- *Status:* open, non-blocking, awaiting owner scope decision.
- *Owner/checkpoint:* owner at Gate Q.
- *Proposed disposition:* renumber as a separate ID (this ledger treats it
  as distinct from CC-55-3a) so the behavior gap and the wording diff are
  tracked and closed independently.

### K-3 — pending owner confirmation of the delivered export surface

- *Source:* `packages/platformer-game/src/index.ts` (public exports of the
  delivered package, recorded for the owner confirmation K-3 awaits).
- *Actual export symbol names (baseline build):*
  - constants: `CAPSULE_HALF_HEIGHT`, `CAPSULE_RADIUS`, `GAME_ZONE_ROLES`,
    `PLATFORMER_GAME_CAMERA_MODULE_ID`, `PLATFORMER_GAME_MODULE_ID`,
    `RUN_LIMITS`, `ZONE_OVERLAP_EPS`
  - zones: `stepZones`, `zoneOverlap`, types `GameZoneRect`, `StepZonesInput`,
    `ZoneDecision`, `ZoneGeometry`, `ZoneTest`
  - session: `createGameSessionModule`, `platformerGameSessionSpec`
  - camera: `CAMERA_CONSTANTS`, `CAMERA_SNAP_EPS`, `createGameCameraModule`,
    `followCamera`, `platformerGameCameraSpec`, types `CameraBounds2`,
    `CameraFollowInput`, `CameraFollowResult`
- *Status:* names recorded; owner confirmation outstanding.
- *Owner/checkpoint:* owner at Gate Q.
- *Proposed disposition:* confirm (or amend) the symbol list; no code change
  requested by packet 63.

### P2-B — `queryProject` v3 content summary missing (re-verified 2026-09-22)

- *Source (contract):* `docs/contracts/commands.md:509–519` (§5.6/§12,
  CC-45-6 promoted at Gate L) — the `queryProject` content summary must carry
  the v3 game/content counts `game` (boolean), `zones`, `spawns`,
  `audioAssets` (counts only).
- *Source (code/evidence):* public
  `openWorkspaceService({root}).query({op:'queryProject', projectId:'demo-0003'})`
  against the committed v3 fixture `fixtures/m3/storage/project-v3-demo-0003`
  returns `{ok, projectId, revision, manifest, scene, history, workspace}` —
  **no `content` field at all** (neither the v2 four-key shape nor the v3
  counts). Re-run: `npx tsx /tmp/p2b-check.mts` pattern (disposable copy of
  the fixture at `<root>/projects/demo-0003/`).
- *Status:* open defect (contract breach, queries surface).
- *Owner/checkpoint:* packet 71 (query parity).
- *Proposed disposition:* implement the bounded content summary in the
  workspace query path; add a contract fixture assertion
  (`fixtures/m2/contracts/commands/queries.json` pattern,
  commands.md:1709).

### M3-GLB — GLB model entities render as empty groups (M3 carry-forward)

- *Source (evidence):* Phase A row A11 (baseline run): the 3 GLB model
  entities of the beacon-reach sample render as empty groups — the M3
  three-adapter builds boxes/lights/surfaces; model attachment is not
  implemented. Raw: `docs/acceptance/evidence-m4/63/raw/a-*.png` +
  `summary.json`.
- *Status:* open (known M3 gap, captured, not repaired here).
- *Owner/checkpoint:* packet 69 (scene model attachment and animation
  resource ownership).
- *Proposed disposition:* packet 69 scope; baseline records the as-shipped
  behavior as the regression reference.

## 2. Real defects found by the packet-63 baseline (M4)

### D-63-2 — preview/export canvas is not keyboard-focusable as shipped

- *Source (code):* `attachBrowserInput` (`packages/input/`) scopes the keydown
  owner to the canvas element; the export wrapper canvas
  (`packages/exporter/src/export-bootstrap-m3.ts`) and the preview canvas are
  created **without a `tabindex`** — a canvas without `tabindex` (or
  user focus) cannot receive the element-scoped keydown.
- *Evidence:* Phase A row A02 + Phase B row B02 (baseline run, `summary.json`
  INFO): keyboard input is unreachable as shipped; with a diagnostic
  `tabindex` shim the same input path works (Phase B B03/B04 PASS).
- *Status:* open delivery defect (keyboard play path broken as shipped).
- *Owner/checkpoint:* packet 70 (both production hosts: visible motion +
  input).
- *Proposed disposition:* make the game canvas focusable (tabindex + focus
  handling) in both hosts, or move the keydown owner to the document with an
  explicit scoping rule; update input.md §5 accordingly.

### D-63-3 — merged into D-63-4 (the missing §5.2 heartbeat is the same receive-only root cause)

The pre-compaction finding “editor client sends no §5.2 heartbeat ping (the
backend §11.5 60 s silent-drop sweeper then closes the idle WS with
`heartbeat_timeout`, code 1000, which the client treats as a deliberate
detach — no auto-reconnect)” is the same root cause as D-63-4: the editor WS
client has **no send path at all**. Tracked under D-63-4 (symptoms: missing
§5.2 heartbeat → silent-drop risk; missing `play.preview.ready` → every play
`preview_timeout` at 15 s).

### D-63-4 — editor WS client is receive-only: `play.preview.ready` can never be sent

- *Source (code):* `packages/editor/src/session/client.ts` — **zero `.send(`
  calls anywhere in the editor package** (verified by grep on the baseline
  build); the WS session is upgraded and read, never written. Two contract
  symptoms:
  1. **§5.2 heartbeat**: the client sends no WS ping (sessions.md §5.2
     requires a client heartbeat at least every 20 s); the backend §11.5
     silent-drop sweeper (60 s, `packages/backend/src/backend.ts` sweeper)
     then closes an idle WS with 1000 `heartbeat_timeout`, which the client
     treats as a deliberate detach (no auto-reconnect) → `session_lost`.
     (Harness workaround in the baseline: real query commands every 15 s —
     row C13.)
  2. **`play.preview.ready`**: the backend requires the WS command
     `play.preview.ready` (`packages/backend/src/backend.ts:612` →
     `plays.markPresented`, `packages/backend/src/play.ts:264`);
     `docs/contracts/sessions.md:887` (“editor sends WS `play.preview.ready`
     (the backend marks `presented`)”) and §10.2 (15 s present timeout,
     `packages/backend/src/play.ts:7,234`; `presentTimeoutMs`
     `backend.ts:242`).
- *Evidence:* Phase C `sessionLog` (real backend session log API) in every
  C-run: `registered` → `play started` → `preview_timeout` at exactly +15 s
  (`c-06-failure.json.sessionLog`, `c-bridge.json`). The play is stopped by
  the present timeout in every baseline run.
- *Status:* open blocking defect (no play can ever reach `presented`; idle
  sessions risk the silent drop).
- *Owner/checkpoint:* packet 70 (or the editor-session repair in 64/71 —
  owner decision at Gate Q).
- *Proposed disposition:* give the editor client the WS command send path and
  relay the preview’s `tl.ready` as `play.preview.ready` (sessions.md §10.2);
  add the retained-event + ready-relay integration test the backend already
  has against a stub (`play.test.ts:113`).

### D-63-5 — v3 preview wrapper never acks the bridge handshake ⇒ the snapshot is never delivered

- *Source (code):* `packages/editor/src/preview/preview-m3.ts:272–276` — the
  v3 wrapper’s `tl.handshake` handler records `trustedSource` + the expected
  build but **never calls `bridge.ackHandshake(...)`**. The M2 wrapper does
  ack (`packages/editor/src/preview/preview-bootstrap.ts:561–565`). The
  editor only sends the snapshot on the ack
  (`packages/editor/src/ui/App.tsx:570` `bridge.on('tl.handshake.ack', …)` →
  `bridge.sendSnapshot`), so the snapshot is deadlocked out.
  Additionally the v3 wrapper registers **no** `tl.input.request`,
  `tl.screenshot.request` or `tl.diagnostics.request` handlers (M2 wrapper
  has them) — the §18 input-relay / screenshot / diagnostics channels are
  unavailable for v3 plays.
- *Evidence (real browser, CDP + in-frame probes, `c-bridge.json`):*
  1. the editor’s real `tl.handshake` is delivered to the preview frame
     (preview-side raw `message` log: `{type:'tl.handshake',
     origin:'http://127.0.0.1:18501', sourceIsParent:true}`);
  2. no `tl.handshake.ack`, `tl.load.progress`, `tl.ready` or `tl.error`
     from the preview ever reaches the editor before the probes
     (editor-side raw transcript: only the control `tl.pong`);
  3. a control `tl.ping` sent by the probe round-trips (`tl.pong` received) —
     the transport + the preview Bridge accept/reject/dispatch/post path are
     healthy;
  4. a probe-sent **valid** `tl.handshake` (real playSessionId/contentId/
     buildId — the `/play` response buildId is 64 lowercase hex;
     `validateBridgeEditorToPreview` ok) also gets no ack;
  5. a probe-sent `tl.snapshot` carrying that probe nonce **is accepted**
     (the Bridge nonce gate passed — the nonce was set by the received
     handshake) and reaches `startM3Preview` (it then fails the manifest
     `sceneDigest` check on the probe’s fake empty scene and answers
     `tl.error` `play_content_not_ready`, phase `manifest`) — proof the v3
     preview CAN receive and process the snapshot, isolating the delivery
     break to the missing ack. (Note: a real snapshot would next hit the
     D-63-9 null-game gap at composition.)
- *Status:* open blocking defect (v3 play never mounts: C06/C07/C09 FAIL;
  preview canvas stays the flat bootstrap canvas).
- *Owner/checkpoint:* packet 70 (both production hosts) with packet 69’s
  model work; the §18 channel gap may split to a separate owner line.
- *Proposed disposition:* ack the handshake in the v3 wrapper (mirror the M2
  `preview-bootstrap.ts:565` call) and register the §18 handlers, or move the
  snapshot hand-off off the ack gate in the editor — owner decision with the
  sessions.md §17.2.1/§13.4 record.

### D-63-6 — v3 wrapper `tl.ready` body fails the §13.5 validator (silently dropped)

- *Source (code):* `packages/editor/src/preview/preview-m3.ts:289` —
  `bridge.sendReady(playId, snapshotId, 0, buildId, '', 0)` sends
  `contentDigest: ''`. `postLocal` validates before posting
  (`packages/editor/src/preview/bridge.ts` `postLocal`);
  `validateBridgePreviewToEditor` for `tl.ready` requires `contentDigest` to
  be 64 lowercase hex (`packages/protocol/src/bridge.ts` `tl.ready` case).
  Verified in Node: the exact wrapper body →
  `{ok:false, reason:'contentDigest must be 64 lowercase hex',
  path:'/contentDigest'}`.
- *Evidence:* Node validator run against the literal wrapper arguments
  (packet-63 run, recorded in `docs/acceptance/evidence-m4/63/raw/`
  notes); `revision: 0` / `stepIndex: 0` are also not the real identity tuple
  the §10.2 ready is supposed to carry.
- *Status:* open defect (latent behind D-63-5: even a successful v3 mount
  would never inform the editor).
- *Owner/checkpoint:* packet 70.
- *Proposed disposition:* send the real identity tuple (manifest
  `contentDigest`, snapshot `revision`, runtime `stepIndex`) in the v3
  wrapper’s ready; the manifest digest is already computed at play build
  (backend `/play` core `contentDigest`).

### D-63-7 — editor client drops the `playContent` locator when the retained `play.started` arrives

- *Source (code):* `packages/editor/src/session/client.ts:447–459`
  (`handlePlayStarted`) rebuilds `activePlay` from a fixed field list that
  omits `playContent` (`contentId`/`buildId`/`path`, sessions.md §17.2) —
  the locator delivered by the `/play` HTTP response (`playStart`,
  client.ts:570–575) is discarded when the one-shot WS event is merged.
- *Evidence:* source inspection; currently masked because `App.tsx:315–317`
  preserves the previous `contentId`/`buildId`/`contentPath` values
  (`setPlayInfo(p => ({…p, …}))`), so the iframe src still carries the
  locator. Any future consumer of `getActivePlay()` (client.ts:582) after
  `play.started` sees the locator missing.
- *Status:* open latent defect (no current user-visible break).
- *Owner/checkpoint:* packet 70 (or 71).
- *Proposed disposition:* carry `playContent` through `handlePlayStarted`
  (spread the base before overriding the WS fields).

### D-63-8 — export wrapper HUD refreshes once at mount (stale during play)

- *Source (code):* `packages/exporter/src/export-bootstrap-m3.ts:224` — the
  HUD line (`snapshotId · build · state · deaths · goal`) is written once in
  the mount `.then`; nothing updates it afterwards.
- *Evidence:* Phase A row A04 (baseline run, INFO): HUD text is stale during
  scripted play.
- *Status:* open minor defect.
- *Owner/checkpoint:* packet 70.
- *Proposed disposition:* drive the HUD from the host observation cadence
  (or a bounded interval) in the export wrapper.

### D-63-9 — the v3 play snapshot contract cannot carry the `game` block the M3 host requires

- *Source (code chain):*
  - the bridge snapshot document is the runtime.md §2 shape — exactly
    `{snapshotId, projectId, revision, scene}` (`packages/protocol/src/ws-events.ts:79–88`),
    and the `tl.snapshot` validator rejects any other top-level snapshot field
    (`packages/protocol/src/bridge.ts:124–127` “unknown snapshot field”);
  - the backend builds exactly that 4-key document for the retained
    `play.started` (and the `/play` snapshot), although the v3 `content.game`
    block is available in the same full state
    (`packages/backend/src/backend.ts:978–988`);
  - the runtime normalizes an **absent** `game` to `null`
    (`packages/runtime/src/snapshot.ts:173`) and an M3-enabled module set
    then fails `config_invalid`/`game_config` (“an M3 module set requires a
    non-null content.game block on the v3 snapshot”)
    (`packages/runtime/src/runtime.ts:593–596`); the game host preconditions
    the same requirement fail-closed
    (`packages/game-host/src/host.ts:451–453`).
- *Evidence:* code-verified chain (above); the packet-63 probe run confirmed
  the v3 preview reaches `startM3Preview` with a 4-key bridge snapshot (the
  probe’s fake scene failed at the manifest `sceneDigest` check —
  `tl.error` `play_content_not_ready`, phase `manifest` — so the null-game
  rejection itself is established by the code path, not yet observed live
  with the real snapshot).
- *Status:* open blocking cross-contract gap (v3 play cannot mount in the
  editor preview even after D-63-5/D-63-6 are repaired: the transport
  contract structurally excludes the `game` block the M3 composition
  requires).
- *Owner/checkpoint:* contract-change request with the owner at Gate Q / the
  repair packet (64 contract, or 70).
- *Proposed disposition:* extend the v3 snapshot document + the `tl.snapshot`
  allowlist with the frozen `content.game` block (runtime.md §2 diff),
  include it in the backend’s retained `play.started` snapshot, and add the
  digest/verification to the preview’s snapshot check
  (`preview-m3.ts` scene-digest step); M2 (4-key, no game requirement) stays
  unchanged.

## 3. Stale-document items (not product defects)

### SD-63-1 — `deployment.md` §5 “copy while it runs” contradicts `workspace.md` §15

- *Source:* `docs/acceptance/deployment.md` §5 (backup/restore wording: copy
  while the backend runs) vs `docs/contracts/workspace.md` §15 (write
  pausing / quiesce requirements for safe copies).
- *Status:* stale/contradictory doc; behavior truth is the workspace
  contract (write-paused copies).
- *Owner/checkpoint:* packet 77 (backup/restore) author + owner at Gate T.
- *Proposed disposition:* reconcile deployment.md §5 to the workspace
  contract; no code change.

### SD-63-2 — STATUS row 62 recorded as pending though packet 62 completed

- *Source:* `docs/STATUS.md` row 62 (pre-packet-63 state) vs
  `docs/handoffs/62.md` (complete, gate evidence recorded).
- *Status:* stale row; corrected as part of packet 63’s STATUS update.
- *Owner/checkpoint:* packet 63 (this run).
- *Proposed disposition:* done — row 62 marked complete with the handoff
  reference.

## 4. Environment / hardware gaps (owner annex — see `reference-device.md`)

- SwiftShader-only WebGL2 in this container: canvas-identity motion rows
  (A05/B04b/C10) are UNVERIFIED by canvas; motion is instead established via
  runtime interpolated-state deltas (B04 PASS). SwiftShader evidence is never
  a hardware-GPU claim.
- No physical keyboard / gamepad / audio / display: input-device and audio
  rows are UNVERIFIED (owner annex); the as-shipped keyboard-focus defect
  (D-63-2) is captured regardless.
- Audio: B05 INFO — pre-gesture audio is blocked by contract (autoplay
  policy); audibility UNVERIFIED.

## 5. Unresolved facts and owners

| fact | owner | checkpoint |
|---|---|---|
| CC-55-3a behavior-linking scope (config diff or defer) | owner | Gate Q (68) / packet 69 |
| CC-55-3b wording-diff disposition (fix wording vs close) | owner | Gate Q (68) |
| K-3 export-surface confirmation | owner | Gate Q (68) |
| Reference desktop/target for hardware rows | owner | 67-B (protocol freeze at Q) / 79 |
| `play.preview.ready` relay ownership (editor vs backend path) | owner | Gate Q / packet 70 |
| §18 relay channels for v3 plays (input/screenshot/diagnostics) | owner | packet 70 |
| D-63-9 snapshot-document contract diff (carry `content.game` on v3) | owner + contract | Gate Q (68) |