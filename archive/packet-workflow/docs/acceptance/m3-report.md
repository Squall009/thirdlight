# M3 report — Beacon Reach (in-container acceptance record)

2026-09-21. **Status: M3 implementation complete through packet 62; Gates M, N
and O accepted (in-session, under the no-sub-session host constraint). The
in-container acceptance evidence for B01–B24 is complete: every Node/API claim
and every browser-executable subclaim the local headless path can run (DOM/HUD,
canvas pixels, console/network, WAV decode, export loading, scripted key events)
is executed and recorded. The subclaims the container physically cannot execute
— physical keyboard/gamepad events, audible output, hardware-GPU behaviour and
real display compositing — are labelled UNVERIFIED and each names an owner
procedure in the §6 manual annex. No owner or independent-human approval of any
M3 artifact exists; nothing in this report is a fabricated measurement, and no
part of it is a placeholder or an inferred result.**

## 1. What has actually been executed

| Step | Result | Record |
|---|---|---|
| M3 plan review (fresh read-only reviewer + coordinator verification) | **ACCEPT WITH BOUNDED FOLLOW-UPS**; PR-1…PR-7 applied docs-only | `handoffs/m3-plan-review.md` |
| Packet 38 — browser baseline and compatibility probes | **done**; real headless Chrome 151 / SwiftShader WebGL 2 path established; **P1 finding C38-1**: the accepted preview CSP blocked Rapier WASM | `handoffs/38.md`, `acceptance/evidence-m3/38/**` |
| Packets 39–42 — contract drafting (model/storage, gameplay/camera, presentation/media, delivery/dependencies) | **done, PROPOSED** | `handoffs/39.md`…`42.md`, `planning/m3-contracts/**` |
| Packet 43 — contract pack integration and audit | **done**; 110-row inventory, traceability matrix, integrated audit checker | `handoffs/43.md` |
| Gate K — fresh architectural review | **ACCEPT WITH BOUNDED FOLLOW-UPS**: 96 accepted / 9 accepted-with-diff / 2 rejected / 2 deferred; blocking B1–B4 | `handoffs/gate-k.md` |
| Gate K bounded repair (FU-1…FU-7 + B3, incl. the coordinator-adjudicated `platformerGameSessionSpec` rename) | **applied docs-only** | `handoffs/gate-k-repair.md` |
| Gate K docs-only promotion | **performed**: 109 of 110 rows applied into `docs/contracts/**`; two new homes (`gameplay.md`, `presentation.md`); PM13 rejected and not applied | `handoffs/m3-promotion.md`, `decisions/0003-m3-sample-game.md` |
| Post-44 bounded contract repair (CC-44-3 migration source fixture, CC-44-4 destination `publishedRevision` reset) | **applied docs-only** + the stale v3 model test repaired by the coordinator; suite green again (138 files / 1768 tests); the repaired sections **owe a fresh re-review before Gate L** | `handoffs/repair-cc44-3-4.md` |
| Packet 44 — v3 model validation and pure migration (`@thirdlight/project-model`) | **done**; 31/31 committed contract fixtures executed through the real validators | `handoffs/44.md` |
| Packet 45 — pure v3 command surface (`@thirdlight/commands`) | **done**; 7/7 scenario messages, 3/3 no-change, 11/12 failure codes replayed through the real engine | `handoffs/45.md` |
| Packet 46 — durable v3 workspace and migration-copy | **done**; v3 envelope load/write through the same `W`, the §16.5 v2→v3 copy operator on real files, real SIGKILL at every copy boundary and the v3 envelope boundary, source tree hashed identical after success and refusal | `handoffs/46.md` |
| Bounded repair CC-46-1 (the packet-39 v2-source fixture was not v2-pipeline-loadable) | **resolved** fixtures+tests-only, coordinator-verified; new checker assertion has a negative control | `handoffs/repair-cc46-1.md` |
| Packet 47 — WAV and animation import inspection (`@thirdlight/asset-pipeline`, + the promoted `pcm-wav` rules in `project-model`) | **done**; `inspectAudio` 12 stages, role-aware GLB proposal (A1–A6), CC-44-2 and CC-44-5 resolved | `handoffs/47.md` |
| Packet 48 — content/API/projection/MCP v3 parity (real backend/WS/stdio MCP) | **done** | `handoffs/48.md` |
| Bounded repair CC-48-1 (the v3 query surface was unreachable through the workspace) | **resolved** code+tests-only, coordinator-verified (workspace dispatch + `tl_content_query target="game"`, asserted over MCP stdio and backend HTTP) | `handoffs/repair-cc48-1.md` |
| Gate L — fresh review + re-review (packets 44–48) | **review BLOCKED on GR-L-1; bounded repair + docs-only promotion applied; [re-review](handoffs/gate-l-rereview.md) ACCEPT WITH BOUNDED FOLLOW-UPS — block lifted, no P1 open** | `handoffs/gate-l.md`, `gate-l-repair-promotion.md`, `gate-l-rereview.md` |
| CC-L-1 repair (the animated-reimport `modelAnimation.version` pin) | **repaired + coordinator-verified; suite green** | `handoffs/repair-cc-l-1.md` |
| Packets 49–50 — gameplay session + respawn/checkpoint (real Rapier, fixed-step) | **done**; death/checkpoint/goal/respawn event traces; blocked-spawn failure | `handoffs/49.md`, `50.md` |
| Packet 51 — follow camera (the single camera owner, §7.2 pipeline) | **done**; numeric fixtures + runtime integration | `handoffs/51.md` |
| Gate M — fresh review (packet 51) | **ACCEPTED** | `handoffs/gate-m.md` |
| Packet 52 — lighting/shadows/surfaces (three-adapter M3 render) | **done** | `handoffs/52.md` |
| Packets 53–54 — rigid animation roles/blending (B14) + browser audio resource owner (B12/B13 logic) | **done** | `handoffs/53.md`, `54.md` |
| Packet 55 — start/completion HUD + single-owner game controls | **done** | `handoffs/55.md` |
| Gate N — in-session review (packets 53–55) | **ACCEPTED** (CC-55-1/1b/2 accepted; CC-55-3 open) | `handoffs/gate-n.md` |
| Packet 56 — gameplay + camera authoring controls (B02/B03/B17) | **done** | `handoffs/56.md` |
| Packet 57 — media/lighting/animation authoring controls (B11/B12/B14/B17) | **done** | `handoffs/57.md` |
| Packet 58 — project-model manifest v2 core + exporter M3 | **done** | `handoffs/58.md` |
| Packet 59 — isolated M3 Play (both-origin preview) | **done** | `handoffs/59.md` |
| Packet 60 — standalone M3 export + production parity (two-tree determinism, §5.4.1 re-measure) | **done** | `handoffs/60.md` |
| Gate O — in-session review (packets 56–60) | **ACCEPTED** (F1–F6 disclosed; CC-55-3 open; no new CCs) | `handoffs/gate-o.md` |
| Packet 61 — author Beacon Reach through supported workflows (assets, capture, step trace, sample integrity) | **done** | `handoffs/61.md` |
| Packet 62 — integrated M3 acceptance + PR-6 headless-browser evidence (this record) | **done in-container**; the physical/audible subclaims are UNVERIFIED (owner annex §6) | `handoffs/62.md`, `acceptance/evidence-m3/62/**` |

Promoted contracts now carry the honest status line: *“accepted by the Gate K
architectural review (a session review — not owner approval and not an independent
human review) under the owner’s M3 execution authorization; final manual review
pending.”*

## 2. Repo state and toolchain (verified after the last change)

- `npm test` **179 files / 2237 tests passed**; `npm run typecheck` (17
  packages), `npm run check-deps` (all exact §7 pins), `npm run check-boundaries`
  (17 packages, 335 source files, 1319 specifiers, 0 violations) and
  `npm run build` (5 built, 0 skipped) all exit 0.
- M1/M2 fixture checkers unchanged and green, including the **binding M2
  bundle-scan** (`tests/integration/m2-play/bundle-scan.test.ts`, `ownFetchSites
  === 2` + the refCount identity) and `fixtures/m2/contracts`.
- M3 checkers green: `fixtures/m3/contracts`, `gameplay`, `media` (13/115),
  `delivery`, `storage`, `audit`; the M3-export determinism + bundle-scan
  (`tests/integration/m3-export/`, 5/5) and the sample integrity + step trace
  (`tests/integration/m3-sample/`, 7/7) are green.
- Contracts: 7 promoted files + 2 new homes; the working tree carries the
  uncommitted M2 + M3 work. **No commit was made** in this session (HEAD stays
  `5b746ee`).

## 3. Acceptance matrix B01–B24 (row-level)

Verdicts separate the **in-container** evidence (Node/API + the real headless
browser path, PR-6) from the subclaims the container physically cannot execute
(physical keyboard/gamepad, audible output, hardware GPU, real display). A row is
PASS only for the subclaims that were actually executed; each UNVERIFIED subclaim
names its owner procedure in §6. “Exec” = evidence id; “owner” = the §6 annex
procedure that must witness the UNVERIFIED subclaim.

| ID | In-container verdict | Executed evidence (record) | UNVERIFIED subclaim → owner procedure |
|---|---|---|---|
| B01 | **PASS** | v1/v2 readability unchanged + v2→v3 pure conversion (44); durable copy-migration, byte-identical source after success/refusal, real SIGKILL at every boundary (46); repaired v2-source fixture (`repair-cc46-1`) | — |
| B02 | **PASS (command surface)** | every authoring-table value has a pure create/edit/query path replayed through the real engine (45); v3 edits/queries/undo/retry/stale over real backend/WS/stdio-MCP (48, `repair-cc48-1`); the sample authored entirely through the command surface (61) | rendered-UI authoring walkthrough (real browser editor) → O-B02 |
| B03 | **PASS** | typed validation, reference/deletion safety, one-command undo, no-change, redo/retry IDs, stale conflict replayed through the real engine + backend/WS/MCP (45, 48, 56–57, 61) | — |
| B04 | **PASS (title / no-movement / keyboard start)** | PR-6 browser: `#hud-root h1` = “Beacon Reach”, objective+instructions as text; two identical pre-Start canvas frames; scripted Enter flips to the playing prompt (`evidence-m3/62`) | gamepad start without phantom jump → O-B04 |
| B05 | **PASS (controller obeys M2; sample traversable)** | Node step trace, real Rapier fixed-step: full traversal→goal, death→start-respawn, post-checkpoint death→checkpoint-respawn (`m3-sample/step-trace`); M2 frozen traces unchanged | human keyboard/controller traversal; browser canvas-level motion (headless render) → O-B05 |
| B06 | **PASS (death events)** | independent geometry fixtures + real fixed-step event trace; the step trace shows exactly one death event per hazard/fall (`m3-sample/step-trace`); sweep precedence per K fixtures (40) | visible death demonstration (video/frames) → O-B06 |
| B07 | **PASS (respawn + reset)** | real Rapier state/counter trace: pre-checkpoint respawn at start, post-checkpoint at the safe spawn; physics/velocity/input/camera reset together (`m3-sample/step-trace`, 50–51) | before/after frames showing no interpolation streak → O-B07 |
| B08 | **PASS (once-semantics + replay)** | transition/event trace: checkpoint activates once, goal wins once + freezes, replay clears checkpoint/deaths + starts at original spawn (49–50, 55) | keyboard + gamepad full run → O-B08 |
| B09 | **PASS (lifecycle)** | start/win/respawn/hidden/disconnected/stopped/failed states + fail-stop (no abandoned step / half-reset) verified (49–50, 55, 59); packet-38 hidden-tab probe PASS | — |
| B10 | **PASS (camera math; physics invariant to aspect; resize executed)** | numeric §7.2 fixtures + runtime integration; frustum clamp + snap; aspect does not change physics (40, 51, 59); **PR-6 browser resize executed**: canvas renders non-black at 16:9 + ~21:9 and the view differs (`evidence-m3/62`) | the visual frustum-framing (camera frames player/next landing) across the resize → O-B10 |
| B11 | **PASS (lighting/shadow logic; scene renders)** | three-adapter lighting/shadow/surface logic + headless render-graph tests (52, 57); the PR-6 browser canvas renders the lit scene (platform/player/lights) (`evidence-m3/62`) | “look consistent” named checklist across viewport + both hosts (WebGL images, degraded capability) → O-B11 |
| B12 | **PASS (WAV import/cue + decode)** | byte-exact positive/negative fixtures + digests + real upload/publish/integrity (47–48, 54, 57–60); PR-6 browser: all 5 cues decode through a real `AudioContext` (`evidence-m3/62`) | — |
| B13 | **PASS (decode/lifecycle/voice-cap/denial)** | decode (PR-6), mute/visibility/disposal/voice-cap + policy-denial allow a full silent game (38, 54–55, 59) | **audibility itself** (no audio device) → O-B13 |
| B14 | **PASS (roles/blending logic)** | real loader/mixer tests: rigid idle/run/airborne + bounded crossfade per instance; reimport/undo restores role+byte identity (41, 47, 53, 57) | rendered animated poses (the GLB courier/beacon are imported but not rendered as animated models — the three-adapter realizes boxes/lights/surfaces/camera) → O-B14 |
| B15 | **PASS (HUD correct; scripted keys reach the canvas)** | PR-6 browser: HUD renders title/objective/instructions/status as text (never HTML); scripted Enter/D/Space reach the focused canvas (keydown spy) (`evidence-m3/62`) | physical keyboard/controller completion + replay walkthrough → O-B15 |
| B16 | **PASS (non-default settings reach hosts, hash-bound)** | measured numeric comparison (defaults vs changed `run_speed`/gravity) + manifest identity; the same captured run is unchanged during a mid-run edit (42, 58–60, 61) | — |
| B17 | **PARTIAL (pure + transport; sample uses direct models)** | prefab copy/import/reimport + real MCP/SDK workflow exist (45, 48, 56–57); the sample authors the courier/beacon as direct model entities (61) | two **independent decoration prefab copies** + one-copy edit + browser/SDK workflow images (no linked-prefab behavior) → O-B17 |
| B18 | **PASS (durability + external-change protection)** | real SIGKILL/restart, durable retry bytes, rejected external change, restored disposable source backup incl. authoritative media (46, 48, 61–62) | — |
| B19 | **PASS (capture/build pinned at one revision)** | actual production closure hashes; revision race/failure injection; old/new Play comparison; cancellation cleanup (58–60, 62) | — |
| B20 | **PASS (preview isolation; bounded, credential-free)** | real both-origin HTTP/WS/SDK negatives (auth/origin/nonce/stale-run/locator/limits); no-browser → unavailable (42, 48, 59) | preview rendered-canvas PNG + separately captured HUD in a real browser → O-B20 |
| B21 | **PASS (export closure; no external dependency)** | graph/content/container scans with negative controls; complete file/hash/MIME list; **PR-6 browser network: 0 external origins** under a non-root static URL (`/games/beacon-reach/`), authoring origin unreachable by construction (`evidence-m3/62`, 60) | — |
| B22 | **PARTIAL (production-composition journey)** | the Node step trace runs Start→death→checkpoint→death→goal→replay through the **same production modules + content** (`m3-sample/step-trace`, 59–61); no sample-only test consumer | editor-host + standalone-host **physical** keyboard/gamepad playthroughs (4 per the matrix) → O-B22 |
| B23 | **PASS (reproducible export; failure preserves old; lifecycle baseline)** | two distinct output trees hashed independently (byte-identical under a fixed clock); timestamp-normalized buildId; cold subprocess builds; load/start/stop/dispose cycles with input/audio/mixer/physics/GPU-object ownership counters (54, 58–60) | — |
| B24 | **PASS (recreatable from documented sources)** | source recipe/license/hash inventory; the recipe replay reproduces the captured scene+content digests exactly (`m3-sample/sample`); provenance + LICENSE committed (61–62) | owner-environment preview/audio/gamepad setup + a clean `npm ci` full-checks run in the owner’s environment → O-B24 |

**Summary**: 22 rows PASS in-container, 2 rows PARTIAL (B17, B22 — the
sample does not create two independent decoration prefab copies, and the
physical playthroughs are not executed), 0 FAIL. The UNVERIFIED subclaims are
concentrated in the **physical** (keyboard/gamepad, audible) and **visual**
(rendered animated poses, cross-host look checklist, preview canvas) categories,
each owned by the §6 annex. M2 keeps its own 16 UNVERIFIED browser/hardware rows
(pending the owner walkthrough); nothing here closes an M2 row.

## 4. Open bounded follow-ups (recorded, with owners and checkpoints)

- **Gate K K-3** — the `platformer-game` export-name adjudication
  (`platformerGameSessionSpec`/`platformerGameCameraSpec`) is flagged for **owner
  confirmation**.
- **CC-44-3 and CC-44-4 — RESOLVED** by the bounded repair
  (`handoffs/repair-cc44-3-4.md`): the migration source fixture is a loadable v2
  scene again, and `workspace.md` §16.5.2 now resets the derived revision
  metadata on copy so the destination satisfies §18.9.2 rule 4. The repaired
  sections (`workspace.md` §16.5.1/§16.5.2; `project-model.md` §12/§13.2/§18.9.2/
  §22.2/§23.11) are **reopened** and owe a fresh architectural re-review before
  Gate L acceptance; packet 44's stale test was repaired by the coordinator and
  the full suite is green again.
- **CC-46-1 — RESOLVED** (`handoffs/repair-cc46-1.md`): the committed
  packet-39 `migration/v2-source` was not actually v2-pipeline-loadable (retry
  `result: {"ok": true}`); the stale record is removed, the index digest and the
  checker updated (negative control exits 1), and the packet-46 migration test
  now seeds from that fixture with a new non-vacuous `retryCleared` test.
- **CC-44-1 and CC-44-6 — answered at packet 46** as section-level proposed
  diffs (`workspace.md` §16.9 exports; `project-model.md` §19.2 / `workspace.md`
  §16.6 item 4 explicit-version precedence) and awaiting Gate L adjudication and
  docs-only promotion.
- **CC-44-2 and CC-44-5 — RESOLVED** at packet 47: the promoted `pcm-wav` rules
  are enforced on load and the three packet-39 audio records were regenerated
  from the real preimage; `project-model` `ERROR_CODES`/`LimitName` gained
  exactly the six animation codes and six limit names.
- **CC-48-1 — RESOLVED** by the coordinator repair (`handoffs/repair-cc48-1.md`):
  the workspace query dispatch now serves `queryGameConfig` and the
  `queryEntities` component filter, and `tl_content_query target="game"` is
  added; asserted over MCP stdio and the backend HTTP `/commands` route.
- **CC-48-2** (the `migrate-copy-v3` route is not named in `sessions.md` §6.3)
  and **CC-48-3** (full-state `scene.schemaVersion` still reports the manifest's
  `1`; C35-5 gap) are open **for Gate L**. **CC-47-4** (the pipeline carries the
  §41.7.2 A codes) is a wording diff; **CC-47-5** is confirmed structurally
  unreachable (five fixed cue keys + ≤1 checkpoint ⇒ ≤6 distinct audio assets),
  so the `audio_cues` cap needs no enforcement — Gate L should rule.
- **CC-45-1/2/3/4/6/8 — RESOLVED** by the Gate L docs-only promotion
  (`handoffs/gate-l-repair-promotion.md`): the failure fixtures aligned to the
  request-pointer/`references`/`ok` shapes, the packet-45 replay de-special-cased,
  and §3.1.1/§5.6/§5.4 stated. **CC-45-5** discharged by leaving the frozen M2
  fixture byte-exact.
- **CC-L-1 (P2) — RESOLVED** (`handoffs/repair-cc-l-1.md`): the animated
  `publishAsset` reimport now bumps `components.modelAnimation.version` to the
  new version, so `captureContent` pins the new bytes (presentation.md
  §41.3.4 rules 4–6); coordinator-verified, suite green.
- **CC-55-3 (open, carried through Gates N/O):** the packet-55 HUD/status
  wording diff (a bounded presentation.md alignment) is recorded and awaiting an
  explicit owner scope decision; it does not block the gameplay/durability/
  export rows. **P2-B (open):** `commands.md` §5.6 documents a `queryProject`
  content summary that no served query returns. **P3 hygiene (open):** the
  frozen M2 `queries.json` example is stale; `fixtures/m3/contracts/README.md`
  describes a removed placeholder. These are recorded debt, not waivers.
- **P2-B (open):** `commands.md` §5.6 documents a `queryProject` content
  summary that no served query returns (the four v1/v2 keys / eight v3 keys).
  Owner: query scope; checkpoint: before M3 acceptance.
- **P3 hygiene (open, M3-acceptance checkpoints):** the frozen M2
  `queries.json` example is stale; `fixtures/m3/contracts/README.md` describes a
  removed placeholder; the two contract envelopes' `modelAnimation.roles` are
  still packet-41 stubs (packet 53 must add a real-roles fixture);
  `commands.md` §3.1.1/§19.2 step 2 wording. (§16.9's symbol names and the
  CC-47-1 note were corrected during the promotion.)
- These are recorded debt, not waivers: none is a licence to weaken an accepted
  contract, and each must be resolved or explicitly re-scoped at its checkpoint.

## 5. Evidence index

| Evidence | Location |
|---|---|
| Real-browser probes — packet 38 baseline (raw JSON/PNG + console/network) | `docs/acceptance/evidence-m3/38/raw/**` (index: `.../38/manifest.md`) |
| **Packet 62 integrated-browser probe (Beacon Reach export): title/HUD canvas PNGs, console/network, WAV decode, summary** | `docs/acceptance/evidence-m3/62/raw/**` (index: `.../62/manifest.md`) |
| Beacon Reach sample (assets, provenance, captured project, recipe, tools) | `samples/beacon-reach/**` |
| Sample integrity + real-Rapier step trace (Node) | `tests/integration/m3-sample/{sample,step-trace}.test.ts` |
| M3-export determinism + bundle-scan (Node) | `tests/integration/m3-export/{determinism,bundle-scan}.test.ts` |
| Browser procedures (manual annex inputs) | `tests/browser/m3-{shell,play,render,audio,animation,media-authoring,authoring,sample,export}/README.md` |
| Contract pack, diffs, consolidated inventory, traceability | `docs/planning/m3-contracts/**` |
| Gate and promotion records | `docs/handoffs/{m3-plan-review,gate-k,gate-k-repair,m3-promotion,gate-l,gate-l-repair-promotion,gate-l-rereview,gate-m,gate-n,gate-o}.md` |
| Packet handoffs | `docs/handoffs/{38.md…62.md}`, `repair-cc46-1.md`, `repair-cc48-1.md`, `repair-cc-l-1.md` |
| Decision (PROPOSED/promoted) | `docs/decisions/0003-m3-sample-game.md` |
| Executable checkers | `fixtures/m3/{contracts,gameplay,media,delivery}/tools/`, `fixtures/m3/audit/tools/` |
| Browser harness (CDP over repo-pinned `ws`) | `tests/evaluations/m3-browser/` |

## 6. Owner manual verification annex (required by packets 38/62)

The rows below are the UNVERIFIED subclaims the container physically cannot
execute. Each names the exact procedure and the artifact to file. This annex is
completed by packet 62; it never claims a result that was not observed, and it is
the owner’s to run on a real desktop. **In-container environment (for reference;
not a substitute):** Linux x86_64, `Chrome/151.0.7922.34` (HeadlessChrome),
ANGLE/SwiftShader WebGL 2 (software rasteriser, **never a hardware-GPU claim**),
1280×720 viewport, origin `http://127.0.0.1:<port>/games/beacon-reach/`
(secure-context **false** — plain http; the export is origin-relative so it is
unaffected), no display compositing, no audio device, no physical gamepad.

**Owner environment to record (required by m3-acceptance.md §5):** browser build
and version; OS/device; GPU/backend string (the reported WebGL renderer string);
display resolution; origin topology and secure-context status; the physical
controller model and its reported mapping; the audio output device and how
audibility was witnessed; the two desktop aspects used for B10 (e.g. 16:9 and
21:9); and, for every UNVERIFIED row, the command or URL to reproduce it.

The owner loads the sample the same way the in-container probe did: build the
export (`npx tsx tests/evaluations/m3-browser/beacon-reach.mts` prints the export
tree; or `exportProjectM3` over `samples/beacon-reach/captured/project.json`),
serve it at `/games/beacon-reach/`, and open it in a real desktop browser.

| Owner id | Row | Exact procedure (owner) | Artifact to file |
|---|---|---|---|
| O-B02 | B02 | In a real desktop browser, author a hazard, checkpoint, follow-camera control and light + a material preset + a WAV cue assignment **through the editor UI**; query through real stdio-MCP. | A recorded UI walkthrough (screen capture) + the MCP transcript, with revision/IDs. |
| O-B04 | B04 | Start the run with a **physical gamepad** (primary face button); confirm no phantom jump. | The gamepad mapping (reported via the input owner) + a frame/run trace showing start without a jump. |
| O-B05 | B05 | Traverse the sample with a **physical keyboard** and with the **controller**; confirm obstacles are cleared without test-only movement. | A video or before/after frames + the event/state trace. |
| O-B06 | B06 | Trigger a hazard death and a fall death; record the **visible** death (flash/respawn). | A short video or before/after frames showing the death + the event trace. |
| O-B07 | B07 | Die before the checkpoint (respawn at start) and after it (respawn at the safe spawn); confirm no interpolation streak. | Before/after frames across each respawn showing no streak + the state/counter trace. |
| O-B08 | B08 | A full run: activate the checkpoint once, reach the goal once, then replay (checkpoint/deaths cleared, start at original spawn) — on **keyboard and gamepad**. | The transition/event trace + checkpoint/goal/replay images. |
| O-B10 | B10 | Run the game at **two specified desktop aspects** (e.g. 16:9 and 21:9); confirm the camera respects the frustum and the physics is unchanged. | Snapshot/physics comparison across the resize at the two aspects. |
| O-B11 | B11 | In the viewport + both game hosts, confirm the “look consistent” checklist (same preset id → same colour/roughness and the same visible key-light direction/hazard contrast); run the degraded-capability probe. | WebGL images from all three hosts + the ownership counters. |
| O-B13 | B13 | With an audio output device, witness the start/jump/checkpoint/death/goal cues **audible** after local activation; confirm muted/denied/absent audio allows a full silent game. | A witnessed-audible checklist or recording + the denial/mute probes. |
| O-B14 | B14 | Confirm the courier/beacon render as **animated** models (idle/run/airborne) with bounded crossfade — the in-container three-adapter realizes boxes/lights/surfaces/camera, not animated GLB models. | Rendered poses (video/frames) showing the animation. |
| O-B15 | B15 | Complete and replay the game with **physical keyboard and controller** (no mouse); confirm disconnect/resume causes no stuck controls. | A full-page UI walkthrough + device/mapping/topology details. |
| O-B17 | B17 | Create **two independent decoration prefab copies** of a model, edit one, confirm the other is unchanged; import a GLB, reimport valid reordered clips (IDs unchanged); reject a missing-role/corrupt replacement. | Stable asset/entity IDs + images + durable bytes; no linked-prefab behavior. |
| O-B20 | B20 | Launch the isolated Play preview from a real browser; capture the rendered canvas PNG and the HUD separately; confirm the bounded MCP control/observation is credential-free and session/run-specific. | A rendered canvas PNG + a separately captured HUD + the both-origin negatives. |
| O-B22 | B22 | Four physical playthroughs (editor host + standalone host × keyboard/gamepad) of Start→death→checkpoint→death→goal→replay; confirm the event/state traces match the captured semantic replay. | The four playthrough traces + images; no sample-only test consumer. |
| O-B24 | B24 | In a clean environment, run `npm ci` + full checks, recreate/restore the sample from the documented sources, and set up the documented preview/audio/gamepad. | A clean-install log + the recreation/restore verification. |

**Reproduce command (in-container browser half, already executed):**
`npx tsx tests/evaluations/m3-browser/beacon-reach.mts` (writes
docs/acceptance/evidence-m3/62/raw/). The owner’s desktop run of the same URL
plus the physical input/audio/GPU witnesses is what upgrades the UNVERIFIED
subclaims.

## 7. Truthful completion statement

**M3 implementation complete through packet 62; in-container acceptance
evidence complete; physical/audible/visual subclaims UNVERIFIED pending the
owner.** The M3 contract pack is promoted (Gate K) and Gates L, M, N and O are
accepted (in-session, under the no-sub-session host constraint). Packets 38–62
are green (179 files / 2237 tests; typecheck 17 packages; check-deps; 
check-boundaries 17 packages/335 files/1319 specifiers/0; build 5 built/0 
skipped; the binding M2 bundle-scan + M3-export determinism green). The 
**in-container** acceptance evidence for B01–B24 is complete: 22 rows PASS,
2 rows PARTIAL (B17, B22), 0 FAIL; every Node/API claim and every 
PR-6-browser-executable subclaim (DOM/HUD, canvas pixels, console/network, WAV
decode, export loading, scripted key events) is executed and recorded under
`docs/acceptance/evidence-m3/62/`.

**The in-container acceptance does NOT include** the subclaims the container
physically cannot execute — physical keyboard/gamepad events, audible output,
hardware-GPU behaviour, real display compositing, the rendered animated GLB
poses, and the cross-host visual look checklist. These are labelled UNVERIFIED
in §3 and each names an owner procedure in §6. Milestone acceptance also
requires the owner desktop walkthrough (m3-acceptance.md §5). No part of this
report may be cited as full M3 acceptance or as owner/independent-human 
approval; it is the in-container acceptance record with the physical/audible 
scope explicitly deferred to the owner. **Gate P** (the final in-session review
of packet 62) is the next step; M4 receives a new planning request only when
the owner asks for it.
