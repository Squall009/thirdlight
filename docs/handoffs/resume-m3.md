# M3 campaign — resume brief (updated after packet 62)

**State:** packets 49–62 complete. **Gates M, N, O ACCEPTED** (M 2026-09-20; N
and O 2026-09-21 in-session, no sub-session available — host constraint). Green
bar post-62 (fresh run 2026-09-21): **179 files / 2237 tests** exit 0, typecheck
17 pkgs, check-deps all exact, check-boundaries 17 pkgs/335 files/1319
specifiers/0 violations, build 5 built/0 skipped; the binding M2 bundle-scan
1/1 + M3-export determinism 5/5; M2 (contracts 34/34) + M3 checkers all green.
HEAD `5b746ee`, no commits. **Packet 62 done** (in-container M3 acceptance
record + PR-6 headless-browser evidence — see below). **Next: Gate P
(in-session review of packet 62), then the M3 acceptance record is final.** No
sub-sessions (host constraint) — all remaining work in this session.

**Packet 62 (done 2026-09-21, [62.md](62.md))**: the M3 acceptance record
(`docs/acceptance/m3-report.md`) — B01–B24 row-level verdicts (22 PASS / 2
PARTIAL / 0 FAIL), the integrated journey, the limitations, and the owner manual
annex (§6, O-B02/04/05/06/07/08/10/11/13/14/15/17/20/22/24). The PR-6
headless-browser path is **executed** (`tests/evaluations/m3-browser/
beacon-reach.mts`, evidence `docs/acceptance/evidence-m3/62/`): builds the
standalone M3 export of the captured sample by the real `exportProjectM3`
pipeline over the 7 real asset bytes (fixed clock → deterministic tree), serves
it at `/games/beacon-reach/`, loads it in headless Chrome 151 (ANGLE/SwiftShader
— software rasteriser, never a hardware-GPU claim) over the CDP harness. Rows:
B04 title/HUD render + no-movement-pre-Start + keyboard start **PASS**; B13 all
5 cues decode through a real AudioContext **PASS** (audibility UNVERIFIED); B21
browser network **0 external origins** **PASS**; console no JS errors **PASS**;
B05 scripted KeyD reaches the focused canvas but the canvas is byte-identical
(headless render limitation) **UNVERIFIED** (the Node step trace is the
authoritative controller evidence). **Sample defect found + fixed:** the baseline
camera was authored at z=0 (in the scene plane → black canvas); corrected to
z=12 (CAMERA_Z) in `capture-project.mts` + `sample.test.ts`, re-captured
(`sceneDigest d339acb1…`, content unchanged), sample tests 7/7. No `packages/**`
change.

**Packet 57 (done 2026-09-21, [57.md](57.md))**: the editor media panel —
`session/media.ts` (pure planning: `validateMediaDrop` .glb/.wav + 32 MiB;
`planCueEdit` = the `setGameConfig` partial edit sending the FULL merged
`cues` block (each present top-level field replaces the whole field);
light/surface/animation/activation parse+plan at the §23.3.x/§8.5.1 bounds;
`planAnimatedReimport`); `session/preview-audio.ts` (`PreviewAudioOwner` —
the editor-page preview UTILITY, NOT the §41.4.7 binding owner — the
boundary row cannot import game-host: gesture-gated context, bounded decode
on a copy, ≤8 voices, per-cue dedupe, idempotent dispose; cue bytes via
`client.assetByteResolver()`); `projection.ts` (`light`/`surface`/
`modelAnimation` on `ProjectedEntity`, type-only project-model);
`asset-browser.ts` + `client.ts` (`kind: 'model'|'audio'` on the inspect +
publish, §8.5.1 `animation`); `viewport.ts` (surface-color preview on
boxes, light arrow/sphere markers); `ui/MediaPanel.tsx` (Cues/Checkpoint/
Lights/Material/Animation tabs); `AssetBrowser.tsx` (the §8.5.1 Animation
mapping section — publish disabled until the role draft is complete);
`App.tsx` wiring + `editor.css`. Tests: `media.test.ts` (40) +
`preview-audio.test.ts` (24, fake Web Audio graph) + the M2
asset-browser kind update (+1) = +65. Browser checklist A1–A9 in
`tests/browser/m3-media-authoring/README.md` — **UNVERIFIED in-container**.
No CCs; CC-55-3 still open (no behavior channel needed here).

**Packet 58 (done 2026-09-21, [58.md](58.md))**: the project-model owns
the pure **manifest v2** derivation (`src/manifest-v2.ts`: `captureManifestV2`
(self-identifying `buildId`), `validateManifestV2` (captured-state re-
derivation), `captureContentViewV3` (kind-tagged assets + resolved six-key
settings + `game` + `contentDigest`), `resolveMediaIdentityV3`, the digest
primitives in the owning contract's key order) + `collectAssetRefsV3` made
public in `src/capture.ts`; the exporter composes the complete **M3 standalone
export** from ONE captured v3 state (`buildContentClosureM3` — shared closure,
fails closed on source-bearing behaviors (CC-55-3); `export-bootstrap-m3.ts`
page bootstrap → `createGameHost`; `export-m3.ts` pipeline (revision re-read →
graph check → manifest self-identity → GLB/**WAV** container scans + §5.4
forbidden patterns + relative closure → `meta.json` v2 → atomic publish);
`checkBundleGraphM3`; `buildM3Bundle`; `scanWavContainer`; v3→M3 dispatcher). The
workspace gains the additive `readCapturedV3` captured-view seam (v1 view
unchanged). **`export-bootstrap-m2.ts` byte-stable.** `npm test` 173/2218.
B16/B19/B21 logic PASS; browser/visual/audible UNVERIFIED. Reopened
project-model §44 row (Gate L, bounded re-review). Limitations: GLB model
rendering gap (box player for 61); §5.4.1 count re-measurement deferred to
58/60; M3 export fails closed on source-bearing behaviors. No commit made.

**Packet 59 (done 2026-09-21, [59.md](59.md))**: editor Play runs the actual
game host from immutable artifacts for v3 projects — one captured input + one
production composition for both hosts. `packages/backend/src/play-m3.ts` (new):
`buildPlayContentM3` = a thin consumer of `buildContentClosureM3` assembling the
v3 set (`manifest.json` v2 [opaque bytes to the version-agnostic
`PlayContentStore`] + declared kind-tagged assets + the prebuilt M3 bundle as
the entry; **NO `scene.json`**); fails closed on the closure closed set. The
`startPlay` v3 branch in `backend.ts` reads the captured state via the
`readCapturedV3` seam + the **M3** bundle (`readGameBundle('preview-m3.js')`)
and builds via `buildPlayContentM3`; the v1/v2 M2 path is unchanged (each branch
reads its own bundle). `packages/editor/src/preview/preview-m3.ts` (new, a
SEPARATE entry): `startM3Preview` (bridge-delivered snapshot → locator
`manifest.json` [WebCrypto `buildId` self-identity + handshake expected build] →
verify the snapshot scene re-hashes to `manifest.sceneDigest` → compose
`createGameHost`) + `bootstrapPreviewM3()` (the locator's `game.js` entry: bridge
handshake → nonce-verified `tl.snapshot` → mount → truthful `ready`). **The M2
`preview-bootstrap.ts` is untouched** (separate entry, never inlined — the M2
§5.4.1 bundle-scan test re-passes). **Key design (accepted M2 content/snapshot
split preserved):** the v3 scene arrives via the nonce-verified `tl.snapshot`
bridge (the accepted §17.2.1 locator route set has NO scene route — a locator
`scene.json` read is `path_rejected` 400); the manifest's `sceneDigest` is the
identity the preview verifies the bridge snapshot against. `tools/build.mjs`
builds the third browser bundle `preview-m3.ts` → `dist/preview/preview-m3.js`
(served as the v3 `game.js`); `tools/build.test.mjs` updated (3 built);
`check-boundaries.mjs` gains the `preview-m3.ts` row (the only editor file
allowed to import `game-host`). Tests: `m3-play.test.ts` (5, Node) +
`play-v3.test.ts` (2, real backend + HTTP: the v3 route serves the v2 artifact
set; **the pin is honored across a live `setSettings` edit (B19/B20)**) +
`tests/browser/m3-play/README.md` (owner-run P1–P10 — **UNVERIFIED in-container**).
`npm test` 175/2225. B04–B16 (Node halves) + B19/B20 PASS; browser/visual/audible
UNVERIFIED. Flags for Gate O (PR-2, bounded interpretations, no schema change):
the scene rides the `tl.snapshot` bridge (no locator scene route in the accepted
§17.2.1 set); the §5 relay routes through the accepted HTTP `/play/:id/control|observe`
(the accepted packet-48 bridge schema has no game-control/observe types). CC-55-3
stays open. GLB model rendering gap carries (box player for 61). No commit made.

**Packet 60 (done 2026-09-21, [60.md](60.md))**: the M3 standalone export
measurement/parity/evidence packet — **no package source changed** (the M3
export pipeline landed in 58/59). NEW `tests/integration/m3-export/bundle-scan.test.ts`
(3): the **§5.4.1 re-measurement** — the reference full-core three (pinned
`three@0.186.0`, §5.3 pinned esbuild options) re-scans to the table (**d=3, f=3,
h=26, j=3; a/b/c/e/g/i=0**, measured 1,777,856 bytes — the 1,777,857 in the
table is a 1-byte newline separator, counts exact); the REAL M3 export bundle
(production `buildM3Bundle` over the shared `buildContentClosureM3` closure, two
assets) scans to exactly the baseline + applicable rows (**d=8 = 3 three + 1
Rapier + 1 `./manifest.json` + 1 `./scene.json` + 2 asset paths; f=3, h=26, j=3**
— **0 from `game-host`**, no GLTFLoader subpath in the M3 graph, no trust notice
in the M3 page) + the production-parity graph (`checkBundleGraphM3` passes;
the bundle links the SAME shared `game-host` + `platformer-game` composition,
no editor/backend source). NEW `tests/integration/m3-export/determinism.test.ts`
(2): **two-tree determinism (B23)** (two exports, same capture, fixed clock, two
different trees → byte-identical file-for-file; `buildId` re-derived from
manifest content; prior-tree-preserved-on-failed-reexport is the existing
`export_snapshot_mismatch` test) + **preview/export parity (B22, Node half)**
(the M3 EXPORT manifest and v3 PLAY manifest for the same capture are the SAME
build — identical `buildId`/`sceneDigest`/`contentDigest`/`settingsDigest`, both
from the SAME `buildContentClosureM3` + SAME single `createGameHost`; the
resolved six-key settings reach both hosts C35-5). NEW
tests/browser/m3-export/README.md (X1–X7 owner-run standalone: independent
static server under a NON-ROOT prefix, backend stopped/unreachable, real browser
+ physical keyboard + gamepad, the recorded network fully relative, audio owner
cue playback, `meta.json` metadata + licenses) — **UNVERIFIED in-container**
(no browser/GPU/audio, packet-38 baseline §1). **Deviation-trigger verdict:**
the packet-42 M3 addition holds exactly as recorded (`game-host` adds 0 to
a/b/c/e/g/i and 0 additional to d/f/h/j) — **no bounded re-review required, no
exception widened**. `npm test` 177/2230. B19/B21/B23 (Node) + B22 Node half
PASS; physical keyboard/gamepad + standalone browser UNVERIFIED (owner-run). GLB
gap carries (box player for 61); CC-55-3 open. No commit made.

**Gate O ACCEPTED (2026-09-21, in-session, [gate-o.md](gate-o.md))** — the
packets 56–60 review: fresh toolchain 177/2230 + all checkers green; §5.4.1
re-measurement independently re-derived (reference three d=3/f=3/h=26/j=3,
a/b/c/e/g/i=0; the real M3 bundle d=8 = 3+1+1+1+2, f/h/j = baseline + 0 from
game-host) → **NO deviation trigger, no re-review, no exception widened**; M2
byte-stability + boundary invariants + the §5 relay surface (accepted HTTP +
MCP, no new bridge wire types) re-verified; B22/B23 re-derived. Adjudicated:
F1 project-model v2 (additive only, v1 unchanged, byte-identical fixture)
ACCEPT; F2 workspace `readCapturedV3` (additive, no derivation duplicated)
ACCEPT; F3 PR-2 scene-rides-the-bridge (matches the accepted M2 split, no schema
change) ACCEPT; F4 PR-2 relay-over-accepted-HTTP+MCP (no schema change) ACCEPT;
F5 GLB model rendering gap (box player for 61) ACCEPT as disclosed;
CC-55-3 ACCEPT as open (61 uses built-in modules only); F6 settings-values query
gap ACCEPT as disclosed. No new CCs applied.

**Packet 61 (done 2026-09-21, [61.md](61.md))**: one complete redistributable
authored sample (Beacon Reach) — **no engine source edits** (all `packages/**`
unchanged this segment). `samples/beacon-reach/`: original self-generated
content (5 PCM WAV cues + 2 glTF 2.0 GLB models — `courier.glb` Body+Arm +
Idle/Run/Airborne clips, `beacon.glb` pillar — a deterministic idempotent
generator `tools/generate-assets.mjs`, per-asset `provenance.json` SHA-256
digests + explicit reuse `LICENSE`; no downloaded third-party content / external
refs / fonts); the captured authored project `captured/project.json` (18
entities / 7 assets, scene.revision=26, `game.title="Beacon Reach"`) authored
through the SAME `@thirdlight/commands applyMutation` the browser + MCP use
(in-process — the identical function the backend command route calls; baseline =
the workspace's NEW v3 project [the single default camera the v3 validator
requires]; the recipe authors the rest via commands, no direct active-envelope
editing); the reproducible command recipe `recipe/commands.json` (26 commands —
replaying over the same fresh baseline yields the EXACT captured scene + content,
identical `sceneDigest`/`contentDigest`). `tests/integration/m3-sample/`:
`step-trace.test.ts` (3 tests — the captured layout over the real `platformer` +
`runtime` + `physics-rapier` [pinned 0.20.0] + `platformer-game` modules at the
ACCEPTED settings, no retuned constants: fall in the first pit before the
checkpoint → death 1 + respawn at the START spawn (X≈3); full traversal clears
the low step + both hazards + both pits, activates the checkpoint once, reaches
the beacon (goal); fall in the second pit after the checkpoint → respawn at the
CHECKPOINT spawn (X≈24)); `sample.test.ts` (4 tests — assets match provenance
digests + §41.4 PCM container [mono 48 kHz 16-bit ≤ 2000 ms]; regeneration
idempotent; recipe replay reproduces the digests; no hardcoded runtime IDs,
every reference resolves). `tests/browser/m3-sample/README.md` (S1–S10
owner-run visual + audible) — **UNVERIFIED in-container** (no browser/GPU/audio,
packet-38 baseline §1). Key physics-port fact: `createPhysicsPort`'s `character`
start must EXACTLY equal the snapshot's controller transform (the runtime
validates `applied == position - previousPosition` within 1e-9 — a mismatched
start fails the first controller step). `npm test` **179/2237** (+2 files / +7
vs post-60 177/2230); typecheck (17) / check-deps (exact) / check-boundaries
(17 pkgs, 335 files, 1319 specifiers, 0) / build (5/0) all green; M2
`bundle-scan` (binding) 1/1. B02/B03/B17/B24 + B04–B15 in-container halves PASS;
UI/MCP-stale-edit/reimport-undo/backup-restore/browser-keyboard-pad/audible/
frame-capture UNVERIFIED (owner-run). Limitations: GLB rendering gap carries
(visible player is a BOX; GLB courier/beacon are imported content not rendered
as animated models); in-process capture (HTTP/MCP transport not exercised — the
command path is byte-identical, disclosed); independent decoration prefab
copies not created (direct model entities; Gate P may require a scoped
box-based repair); no new CCs (CC-55-3 stays open). No commit made.

**Next: M3 in-container acceptance is FINAL** — Gate P ACCEPTED (2026-09-21,
`docs/handoffs/gate-p.md`, in-session). The M3 acceptance record
(`docs/acceptance/m3-report.md`) is complete (B01–B24: 22 PASS / 2 PARTIAL / 0
FAIL) and the PR-6 browser evidence is executed. The physical/audible/hardware-
GPU rows upgrade only with owner-run evidence (the §6 annex). **M4 receives a new
planning request only when the owner asks for it.** No sub-sessions (host
constraint) — all work was in this session.

**HOST CONSTRAINT (user directive, 2026-09-20, DOMINANT): NO sub-sessions**
— the vLLM host running this session has no KV cache for children. **ALL M3 work
(packets 58–62, Gates M/N/O/P, the M3 acceptance record) was performed in THIS
session.** Gate protocol in-session: fresh full toolchain re-run + fixture
checkers, reviewer-side verification (contract re-read of the gate scope,
independent re-derivation of adjudicated items), gate doc with verdict + the
signature "reviewed in-session (no sub-session available — host constraint)",
apply accepted CCs, record in `docs/handoffs/gate-*.md`.

## Open CCs (adjudicate at Gate O / P)
- **CC-55-3** (open, NOT implemented — Gate N accepted it as open): the
  §3.1 config has no behavior-linking channel; the 55 composition rejects
  behavior-carrying scenes fail-closed (`host_config_invalid`/`behaviors`).
  Required by 57/59 if a delivered game carries behavior records.

(All other Gate-N CCs — CC-55-1, CC-55-1b, CC-55-2 — were accepted and are
implemented; findings F1–F5 disclosed and accepted.)

## Key packet-56 facts (for Gate O re-derivation)
- **Editor architecture (56):** `session/gameplay.ts` (pure planning: the
  6-key settings registry mirror with the slide≤climb cross-rule; the game
  config form parse — string bounds 64/160/320, ID syntax, level rules;
  the reference preflight; `planSetGameConfig` create=complete block with
  null cues / edit=changed fields only / cues NEVER touched;
  `planCreateZone`/`planEditZone` — the checkpoint fields in the same
  value, the two-step remove-then-re-add for a checkpoint role switch
  (`steps[]`); `planCreateSpawn`; the camera follow parse/plan),
  `session/zone-gesture.ts` (pure gesture: move/resize/create;
  `commandDecisions` 0/1/0; bounded `revision_conflict` rebase ≤1, move
  only — re-applies the delta to the re-read base; negligible create drag
  → role default at the anchor; unplannable checkpoint create → noop),
  `viewport/zone-overlay.ts` (imperative three.js: zone rectangles + spawn
  cones + cameraFollow bounds on the z=0 game plane; pointer routing —
  tool→create / handle→resize / body→move / else unconsumed;
  `screenToGamePlane` = ray ∩ z=0; preview mesh), `viewport/viewport.ts`
  (overlay consulted FIRST on pointer down; `onZoneGesture*` callbacks),
  `ui/GameplayPanel.tsx` (Game/Zones/Camera/Settings tabs; the zone tools
  live inside the panel — no Toolbar/Inspector/Hierarchy edits),
  `ui/App.tsx` (the gesture driver: base pose from the projection at
  gesture start; the single commit at the gesture's expected revision;
  the spawn tool creates a `playerSpawn` marker via `planCreateSpawn`,
  not a zone — the 56 wiring fix; Esc = cancel gesture else clear tool),
  `session/projection.ts` (v3 components hydrate + `setComponent` change
  convergence; `setGameConfig`/`applySurfacePreset` advance without a
  gap), `session/client.ts` (the `content.game` block from
  `queryGameConfig` on EVERY full resync + applied change records; the
  settings map from applied `setSettings` changes; the new command
  wrappers over the envelope path).
- **Backend merge semantics (56 decisions):** `setComponent` replaces the
  canonical fields PRESENT in `args.value`, keeps absent ones (the
  `COMPONENT_FIELD_ORDER_V3` merge in `content-ops.ts`) — hence a single
  edit CANNOT drop the checkpoint fields → the two-step switch.
  `value: null` removes the add-capable component.
- **Settings values gap (contract limitation, documented in the panel +
  handoff 56):** no accepted query returns settings VALUES (`queryProject`
  carries the `settingsKeys` count only). The panel seeds from registry
  defaults, tracks from applied changes, submits touched keys only. NOT a
  CC (the contract is binding; safe degradation).
- **Zone entities:** root `group`, unit scale, identity rotation (so
  `zone_transform_unsupported` cannot trigger); move = one
  `setTransform`; resize = one `setComponent(gameZone, {size})`; create =
  one `createEntity` with `components.gameZone` (checkpoint carries
  `safeSpawnId` + the default activation `#1bc8ff`×1.2, `cueAssetId:null`
  = "use `content.game.cues.checkpoint`" — the appearance EDIT is 57's).
- **57-ready seams:** `planSetGameConfig`'s edit path omits `cues` — the
  57 cue pickers must send the partial `setGameConfig` with the `cues`
  field themselves (the `changedFields` the backend computes will include
  `cues`); the checkpoint activation edit = the ordinary `setComponent`
  `gameZone` partial (`activation` only) via the existing wrapper.
- **Editor boundary row (unchanged):** project-model/commands types-only;
  the 6-key registry + all bounds tables are mirrored locally in
  `session/gameplay.ts` (frozen values from commands.md §8.11 +
  project-model §23.3/§23.4).
- **Browser host pattern (56):** `tests/browser/m3-authoring/README.md`
  (Z1–Z11 checklist; the workspace build emits the editor page
  `dist/editor/index.html` with the build-injected
  `window.__thirdlightEditor { v, projectId, previewOrigin,
  authoringToken }` — `THIRDLIGHT_PROJECT_ID` / `THIRDLIGHT_EDITOR_TOKEN`
  env at build time; backend deployment per sessions.md §13.7 / the
  m2-play README). UNVERIFIED in-container (no browser).

## Carried items (do not lose)
- P2-B: `commands.md` §5.6 queryProject content summary (owner before M3
  acceptance; 57 did NOT touch it — still 58–62's to check).
- P3: docs/fixture hygiene (roll into the acceptance record).
- M4 out of scope. No git commits (HEAD stays `5b746ee`).
  Browser/visual/audible rows UNVERIFIED (no browser/GPU/audio device
  in-container; packet-38 baseline §1).
- `write` tool truncates files at ~14KB — long files via chunks or bash
  heredoc. `edit` is all-or-nothing per call. check-boundaries UNITS must
  list every implemented package.
- Carried API facts: the audio owner (`createGameAudioOwner`, the 8
  binding members + `diagnostics()` + `liveVoices()`), the game host
  (`createGameHost` with `buildId`/`assetPaths?`/`document?` per CC-55-1,
  the adapter FACTORY per CC-55-2, the read-only `runtime` seam per
  CC-55-1b), the input owner (`attachBrowserInput` with `sampleMenu()` /
  `markConfirmConsumed()`; `MENU_CONFIRM_CODES=['Enter','Space']`,
  `MENU_MUTE_CODE='KeyM'`).
- Fixture-pinned doubles (51): `HALF_W_16_9=8.836555997292695`,
  `X_CLAMP_16_9_MAX=39.16344400270731`. Real cue fixtures:
  `fixtures/m3/media/wav/cue-{start,jump,checkpoint,death,goal}.wav`
  (+ min/max/preimage, `wav/rejections/*`), digest-pinned.
- Runtime facts: `gameCommand` QUEUED, consumed at the next step boundary;
  `start` only in `awaitingStart`, `replay` only in
  `playing|respawning|won`; replay → `playing` directly (fresh epoch,
  counters/checkpoint reset, START spawn); `GameEventKind` has NO jump
  event (derived from the committed `playerMotion`
  grounded→airborne); the effective-frame neutral rule during
  awaitingStart/won/respawning + the first-live-step jump gate
  (gameplay.md §2.5).

## Green bar (post-57, verified in-session 2026-09-21)
- `npm test`: **168 files / 2166 tests**, exit 0 (+2 files / +65 tests vs
  166/2101)
- typecheck 17 pkgs · check-deps all exact · check-boundaries 17
  pkgs/329 files/1272 specifiers, 0 violations · build 4 built/0 skipped
- M2: contracts 34/34. M3: audit 0 failed · promotion PASS · contracts 39
  groups · delivery 16/153 · gameplay 127 · media 14/119 · storage 9/10.
- HEAD `5b746ee`, no commits.