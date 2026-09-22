# M4 delivery contract — delivered rendering, queries and compatibility
## (packet 64 proposal; Gate Q)

**Status: ACCEPTED at Gate Q (2026-09-22)** — promotion applied to the
accepted contracts per `docs/handoffs/m4-promotion.md` (owner pre-approval
under the standing M4 authorization; final owner manual review pending).
The rows C64-1…C64-8 are recorded in `diffs/*.md`; the promotion record is
the disposition of record. This document specifies the exact minimal
diffs for the delivery/read gaps observed by the packet-63 baseline
(`debt-ledger.md`, evidence `docs/acceptance/evidence-m4/63/raw/`). It
defines exact shapes/public APIs, validation order, limits, errors,
ownership/disposal, revision semantics, compatibility and fixtures. It
changes no accepted contract by itself: every contract text change below
is an owned diff row in `diffs/*.md`, promoted only by the explicit
docs-only promotion handoff (`handoffs/m4-promotion.md`) after the Gate Q
review. Later packets (69/70/71) consume the **promoted** text.

## 0. Relation to the accepted contracts (PR-M4-1)

**(a) Exact `docs/contracts/**` sections whose owned diff rows change:**

| Contract | Section | Diff row | Change |
|---|---|---|---|
| `commands.md` | §2 op table | C64-1 | add the `querySettings` row (query, no revision) |
| `commands.md` | §3.1 (new §3.1.12) | C64-1 | the `querySettings` operation spec |
| `commands.md` | §5.6 | C64-2 | the accepted `queryProject` content summary: exact count semantics (additive clarification) |
| `presentation.md` | §41.3.6 | C64-3 | rule 7 clarification (static model; the run proceeds); non-player animated entities pin the neutral view ⇒ `idle` |
| `presentation.md` | §41.9 | C64-4 | the `createSceneAdapter` options `models` block + `SceneAdapterDiagnostics.models` counters (additive, root subpath, no new subpath/pin) |
| `export.md` | §5.2 | C64-5 | M3 entry file row correction (`export-bootstrap-m2.ts` → `export-bootstrap-m3.ts`; the exact M3 exporter file list) |
| `dependencies.md` | §4/§5 | C64-6 | the M3 play-preview and M3 export bundle graphs include the `three-adapter` `./gltf-loader` subpath (the `export.md` §5.4.1 GLTFLoader row applies per-bundle) |
| `runtime.md` | — (no change) | C64-7 | no-change record: §2 already mandates the v3 `game` field; D-63-9 is an implementation repair |
| `sessions.md` | — (no change) | C64-8 | no-change record: §13.4/§17.6/§10.2/§5.2 already mandate the observed repairs; D-63-4/5/6/7 are implementation repairs |

**(b) New home file after promotion:** none. Every packet-64 row is a diff
against an existing accepted contract (or a no-change record); this
document itself is archived as the proposal record. The M4 new-home files
(`templates.md`, `distribution.md`, `reliability.md`) belong to packets
65/66/67 and are out of scope here.

**(c) Unrelated same-base-name M3 proposal:**
`docs/planning/m3-contracts/delivery.md` (the M3 delivery contract —
manifest v2, the `createGameHost` composition, the §4/§5 relays, the CSP
diff — accepted at Gates K–P) remains fully in force. This document is an
additive M4 repair layer over it; it restates nothing from the M3 document
and supersedes no M3 section. Where this document cites M3 delivery text
(e.g. the §3.1 `HostRenderAdapter` surface), the M3 text is the binding
one.

## 1. Observed gaps → this document

| Gap (ledger ID) | Observed behavior (packet 63) | Addressed in |
|---|---|---|
| M3-GLB | the 3 GLB `model` entities of the beacon-reach sample render as empty groups; `createSceneAdapter` realizes only `box`/`camera`/`light`/`surface` (adapter.ts:171–205); the host's `HostRenderAdapter` surface (`renderFrame`/`dispose`) is satisfied but the scene graph has no model nodes | §2 |
| D-63-4 | editor WS client is receive-only (zero `.send(` in the editor package) ⇒ no §5.2 heartbeat, no `play.preview.ready` ⇒ every play `preview_timeout` at +15 s (sessionLog in every C-run) | §4 |
| D-63-5 | the v3 preview wrapper never acks `tl.handshake` (preview-m3.ts:272–276) ⇒ the editor never sends `tl.snapshot` (App.tsx:570 ack gate) ⇒ the host never mounts (C06/C07 FAIL); the v3 wrapper registers no §18/§20 relay handlers | §4 |
| D-63-6 | the v3 wrapper's `tl.ready` body (preview-m3.ts:289) carries `contentDigest: ''` ⇒ fails the §13.5 validator (`contentDigest must be 64 lowercase hex`) ⇒ silently dropped even on a successful mount | §4 |
| D-63-9 | the retained v3 `play.started` snapshot document is built 4-key (backend.ts:978–988) although runtime.md §2 mandates the `game` field for v3; the protocol `RuntimeSnapshotDoc` type and the `tl.snapshot` bridge allowlist structurally exclude it ⇒ an M3 module set fails `config_invalid`/`game_config` at `instantiateRuntime` | §5 |
| P2-B | `queryProject` returns **no `content` field at all** (v2 four-key summary and the v3 counts both absent; session.ts:2192–2208) | §3 |
| settings default-fallback | the editor settings panel is seeded from registry defaults when it has not observed a `setSettings` change (client.ts:199–207 comment) — a default-based reconnect guess; no accepted query returns settings values | §3 |
| CC-55-3a/b | behavior-linking channel absent (fail-closed `behaviors_unsupported` / `host_config_invalid`/`behaviors`) + the HUD/status wording diff — one ID used for two matters | §6 |
| export entry row | accepted `export.md` §5.2 names `export-bootstrap-m2.ts` as the M3 page bootstrap; the accepted implementation (m3 graph check, `M3_EXPORTER_FILES`, graph.ts:107) uses `export-bootstrap-m3.ts` | §6.4 |

## 2. Delivered rendering — model attachment and animation resource ownership

The M3 production hosts (preview + export) must realize every `model`
entity as an attached GLB instance with per-instance animation state, in
the same single frame loop, with the accepted resource lifetimes. This
section specifies the minimal additive surface; the existing packet-26
adapter primitives (visual resource store, cancellable prepare,
`ModelInstance`, ownership ledger) and the packet-53 role controller are
reused unchanged as the implementation substrate.

### 2.1 Model bytes: origin, verification, injection

- Model bytes reach the browser **only** through the accepted read paths:
  the preview's immutable locator (`content/sha256/<sourceDigest>`,
  sessions.md §17.2.1) and the export's relative output tree
  (`export.md` §3/§5.3). The bytes are **digest-verified before use**:
  each declared asset path is read exactly once (the accepted
  `1 + |unique declared artifacts|` fetch rule) and re-hashed against the
  manifest row's `sourceDigest`; a mismatch is a hard failure (§2.7),
  never a retry and never a fallback to another path.
- **No fetch in `game-host`, no fetch in `three-adapter`** (the accepted
  invariant, M3 delivery §6.5): the wrapper reads the bytes; the wrapper
  passes the bytes to the host config (`readArtifact` — the existing
  CC-55-1 surface) and to the adapter (the §2.2 `models` block). The host
  and adapter never receive a token, URL or fetch capability.
- The adapter's injected byte source is the existing
  `AssetByteSource` shape (`suppliedBytes`/`injectedResolver`, root
  subpath, packet 26): the `models` block's `resolveBytes` is the
  wrapper's in-memory map of the already-read-and-verified bytes. A
  second network path is not introduced.

### 2.2 The adapter `models` option (exact shape, additive)

`SceneAdapterOptions` gains one optional field (presentation.md §41.9
row, C64-4). Absent ⇒ the adapter behaves exactly as accepted today
(M1/M2 and any M3 scene without model realization — byte-stable, the
M2 §5.4.1 evidence is unaffected).

```ts
interface SceneAdapterModelAsset {
  readonly assetId: string;      // the manifest `assets` row's assetId
  readonly version: number;      // the resolved immutable version (manifest row)
  readonly sourceDigest: string; // 64 lowercase hex (the manifest row's digest)
}
interface SceneAdapterModelAnimation {
  readonly entityId: string;     // an entity carrying components.modelAnimation
  readonly roles: ModelAnimationRoles;  // presentation.md §41.3.1 (the committed mapping)
  readonly version: number;      // the (assetId, version) the mapping is owned by
}
interface SceneAdapterModels {
  /** The resolved model assets for this snapshot (manifest `assets` rows,
   *  kind "model", ascending assetId then version — the manifest order). */
  readonly assets: readonly SceneAdapterModelAsset[];
  /** One entry per `modelAnimation` entity (manifest `media.animation`,
   *  ascending entityId). Empty ⇒ no selectors. */
  readonly animation: readonly SceneAdapterModelAnimation[];
  /** Resolves one (assetId, version) to the wrapper-verified bytes.
   *  Must resolve only manifest-declared rows; anything else rejects.
   *  Synchronous in effect after the wrapper's read phase (no second
   *  fetch); the Promise shape matches AssetByteSource. */
  readonly resolveBytes: (assetId: string, version: number) => Promise<ArrayBuffer>;
}
// SceneAdapterOptions gains:  models?: SceneAdapterModels;
```

Validation (fail-fast, additive; the adapter never re-validates the scene):
`models` present with `scene.schemaVersion !== 3` ⇒ `config_invalid`
class adapter error `models_config_invalid` (a new code in the closed set,
C64-4 — the adapter's set otherwise stays unchanged); an `animation` entry
naming an entity without `modelAnimation` (or whose `assetId`/`version`
does not match the entity's component/`assets` row) ⇒ `models_config_invalid`
(defensive residual: the manifest is closure-validated, so this cannot
occur for a well-formed capture).

### 2.3 Scene realization of `model` entities

- Every entity with `components.model` gets its **existing holder
  Object3D** (the `objects` map entry — a `Group` today) as the model
  root's parent: the prepared `ModelInstance` root is attached **as a
  child of the holder**. The runtime's interpolated transform moves the
  holder (runtime.md §6, unchanged); the model's internal node
  transforms are holder-relative. **The animation writes only mixer
  time/weights — never the holder or any entity transform** (the accepted
  §41.3.6 rule 6 restated for the attached case; C02 "no
  physics-root animation writes" holds by construction: the `model`
  entity's physics/controller components ride the holder, which the
  runtime owns).
- The wrapper's `media.animation` (manifest) is the only animation
  source; the scene's `modelAnimation` component supplies the committed
  mapping re-checked at load (stage 5–6 re-check against the prepared
  clips, §41.3.6 rule 7). The A1–A6 profile facts (clips, tracks,
  root-motion absence, no skin) were validated against the **same
  digest-bound bytes** at publication, so the load path re-checks clip
  names/ambiguity only — no re-parse of the profile.
- Materials: GLB-authored materials stay (accepted §18.1: `surface` never
  overrides GLB material slots). **Per-instance material independence**
  (the accepted §41.6 rule 3) requires each `ModelInstance` to own
  cloned material instances: an emissive change on one entity (the
  checkpoint appearance, §41.5.3) never changes another instance or the
  shared `PreparedVisualResource`. Cloned materials are owned by the
  instance and released by its `dispose()` (the §41.6 ledger row
  "per-entity material instance" extends to model instances; the
  ownership counters count them).
- A `model` entity whose `assetId` resolves to no `assets` row (defensive
  residual) is realized as a plain group with one bounded diagnostic
  `models_asset_unresolved` (the new `models` diagnostic, §2.5) — the
  run proceeds; this state is unreachable for a well-formed capture
  (the closure includes every reachable asset).

### 2.4 Independent animation and the single update loop

- **One `AnimationRoleController` per `modelAnimation` entity** with a
  prepared instance (the packet-53 controller, root subpath). Each
  controller owns its own `AnimationMixer`/`AnimationAction`s (the
  accepted §41.3.6 rule 5: no global mixer, no shared action, no shared
  clock). Two instances of the same asset in different roles at the same
  time is required behavior (C02 per-instance independence).
- **Role selection input.** The controller's view provider is wired to
  the committed read-only `GameView` (the adapter holds the `runtime`
  seam it already receives in `SceneAdapterOptions`): `stepIndex` +
  `playerMotion` from `runtime.getGameView()` (committed; the selector
  never reads authoring state or samples input — accepted rule 1).
  **Player vs non-player:** the committed view carries the **player's**
  motion only. For the player's own animated model, the provider returns
  the committed `playerMotion` (full `idle`/`run`/`airborne` selection,
  accepted rule 3). For **non-player** animated entities (decorations),
  the provider returns the constant neutral motion `{ speed: 0,
  grounded: true }` — the accepted pure selector then yields `idle`
  forever (no blending, no `run`/`airborne` for a non-player). No new
  selector API, no tuning key, no second motion source.
- **One host-driven update, one loop.** The runtime's frame driver
  (runtime.md §6: step → `onFrame` → render) remains the **only** loop
  owner. The host's `hostFrame` (M3 delivery §3.1) calls
  `adapter.renderFrame()` exactly as today; **inside `renderFrame`** the
  adapter performs, in this order: (1) sync the interpolated transforms
  into the holder Object3Ds (accepted, unchanged); (2) for each live role
  controller, one `update(deltaSeconds)` with the real frame delta
  clamped to the accepted `[0, 0.25]` range (first frame after mount or
  after a suspend/resume uses the clamped value; the host's §4.6
  frame-time reset makes a resume a fresh anchor — the clamp is the
  adapter-side bound, no fast-forward); (3) `renderer.render`. The
  controllers install no `requestAnimationFrame`, no timer, no mixer
  listener (accepted rule 2). There is **no second loop**: C13's
  "extra frame loop" failure is ruled out by construction and asserted
  by the packet-70 browser evidence (one rAF consumer per page).
- `deltaSeconds` is derived by the adapter from `performance.now`
  (guarded; the adapter is browser code — Node unit tests drive the
  controller surface directly, which the accepted `animation.test.ts`
  pattern already does).

### 2.5 Resource lifetime and counters

- **One visual resource store per adapter** (the packet-26
  `createVisualResourceStore`), created lazily when `models` is present,
  owned and disposed by `SceneAdapter.dispose()` (idempotent, accepted
  §41.6 rule 1). The store's prepared resources are refcounted by their
  instances: disposing the **last** `ModelInstance` of an asset releases
  the shared `LoadedGlb` exactly once (`LoadedGlb.dispose()` once);
  disposing one of two instances leaves the other fully usable (the
  accepted §41.6 rule 2, fixture `ownership/ownership-cases.json`
  pattern extended to the attached case).
- **Per-entity instance lifetime:** the instance (holder child + cloned
  materials + controller) is created when the entity's prepare completes
  and is disposed by (a) `SceneAdapter.dispose()` or (b) the host's
  replace path when a new snapshot replaces the scene realization
  (accepted §41.6 rule 4: one release, exactly once).
- **Counters.** `SceneAdapterDiagnostics` gains one bounded additive
  block (C64-4):

  ```ts
  models?: {
    assets: number;     // prepared resources (ready + pending + failed)
    instances: number;  // live ModelInstances
    pending: number;    // in-flight prepares
    animations: number; // live role controllers
    failed: number;     // hard-failed prepares (see §2.7)
  };
  ```

  No paths, tokens, asset IDs or byte lengths — counters only (the
  relay/diagnostics bound, M3 delivery §5.4 "nothing binary or
  sensitive crosses"). The block is absent when `models` is absent.
  These counters are the bounded observation surface packet 78's
  diagnostics aggregate consumes.

### 2.6 Stale load cancellation

- **Hidden or disposed run:** a *hidden* run (tab hidden / preview frame
  stopped — the host's rAF loop is paused by the browser) neither
  disposes nor accumulates: the controllers hold no clock of their own
  (driven only from `renderFrame`, §2.4), and the first delta after the
  pause is clamped to `[0, 0.25]` (no animation fast-forward). A
  *disposed* run (any teardown below) cancels in-flight loads and
  disposes the store; a late completion after disposal is discarded and
  released (never applied, never counted as a success).
- **Wrapper teardown (stop/play stop/locator expiry/page unload):** the
  wrapper cancels every in-flight prepare handle (`handle.cancel()`)
  before disposing the host/adapter; a cancelled or superseded load
  resolves `ok: false` (`asset_load_cancelled` / `asset_load_stale`) and
  its late completion is **discarded and released** — never applied to
  the scene (the accepted packet-26 semantics, restated for the host
  path). Disposal after a late completion is safe (the resource state is
  terminal).
- **Superseded duplicate load** for the same `(assetId, version)` (two
  prepares racing, e.g. a wrapper retry within the same mount): the
  older handle is marked stale by the store; only the latest may apply.
- **Reimport during a pinned Play (late completion after
  stop/reimport — the packet-64 failure case):** the active preview
  keeps its **pinned** snapshot and content (accepted §19.2/§19.3
  pinning; M3 delivery §2.6; presentation §41.3.4 rule 6). A reimport
  publishes a new version into the authoring project; it produces a
  *different* `snapshotId`/`contentId` and is visible only to a **new**
  play. The old locator's bytes are immutable and retained
  (sessions.md §17.3/§17.4 cleanup rule). Nothing in-flight is re-pointed;
  a play that stops while a load is in flight cancels (§2.6 first bullet)
  and the new play (new contentId) reads the new build.
- **Snapshot identity gates precede asset reads:** a
  `sceneDigest`/`gameDigest`/`buildId` mismatch fails at the manifest
  phase (phase `"manifest"`, §2.8) — no asset bytes are fetched, no
  runtime is instantiated, and the page never renders a half-verified
  scene.

### 2.7 Corrupt vs degraded outcomes (closed table)

"Corrupt" outcomes are **hard failures of the host mount** (the preview
posts `tl.error` with the phase; the export shows the structured on-page
error; the play is never `presented` — the accepted §13.4 step 6
truthful-failure rule). "Degraded" outcomes are the accepted
capability/policy states (playable or the accepted unplayable page).
There is **no partial scene with a missing model and no silent
fallback** (C14: "corrupt required media is not success").

| # | Condition | Outcome (both hosts) | Phase / code |
|---|---|---|---|
| L1 | manifest identity mismatch (`buildId`/`sceneDigest`/`gameDigest` vs the handshake/snapshot) | hard failure before any asset read; no runtime | `tl.error` phase `"manifest"`, `play_content_not_ready` (the accepted code) |
| L2 | a declared asset read fails or its re-hash ≠ `sourceDigest` | hard failure; no runtime | phase `"assets"`, `asset_corrupt` (adapter closed code) |
| L3 | the loader port rejects the verified bytes (bad container/JSON) | hard failure; no runtime | phase `"assets"`, `asset_corrupt` |
| L4 | the GLB needs an unsupported extension / an embedded image fails to decode | hard failure; no runtime | phase `"assets"`, `asset_extension_unsupported` / `asset_image_invalid` |
| L5 | a structurally invalid animation clip in the prepared resource | hard failure; no runtime | phase `"assets"`, `asset_clip_invalid` |
| L6 | a `modelAnimation` mapping does not satisfy the loaded clips (stage 5–6 re-check) | the **model renders statically at its committed transform** (no animation); one bounded diagnostic; **the run proceeds** — §41.3.6 rule 7 restated: "does not run gameplay" means the *role selector* for that model does not run; the runtime's run is unaffected (the model itself loaded successfully; the residual case is digest-gated defense-in-depth) | no `tl.error`; the `models` diagnostic carries `animation_role_unresolved` |
| L7 | no WebGL context | the accepted unplayable page (presentation §41.1.4); no model realization attempted | `render_unsupported` (adapter code, on-page message) |
| L8 | audio blocked pre-gesture | playable, sound `blocked` (the accepted M3 rule); audio never gates model realization | sound status in the observation |
| L9 | a load is cancelled/superseded (§2.6) | not an error; the late completion is discarded | `asset_load_cancelled` / `asset_load_stale` (terminal, counted) |

### 2.8 Both-host loading order (exact sequence)

**Preview (v3 play):**

1. `GET /play/<playSessionId>?content=<contentId>` ⇒ the shell page
   config (v2, sessions.md §13.2); the `game.js` bundle (the preview-m3
   bundle) loads under the accepted CSP.
2. Editor iframe `load` ⇒ editor sends `tl.handshake` (nonce, demo,
   bridgeVersion 2, contentId, buildId).
3. The v3 wrapper validates origin/source/`playSessionId` ⇒ **`tl.handshake.ack`**
   (nonce echoed). *(Accepted §13.4 step 2 — the M2 wrapper already
   implements it; the v3 wrapper must implement it identically. D-63-5.)*
4. Editor sends `tl.playContent.expect` and — after the ack — `tl.snapshot`
   (the runtime.md §2 document, **with the v3 `game` field**, §5).
5. Wrapper: `fetch("./manifest.json")` ⇒ validate manifest v2: `type`
   gate, `buildId` == the handshake's expected build, the snapshot
   `scene` re-hashes to `manifest.sceneDigest`, the snapshot `game`
   re-hashes to `manifest.gameDigest` *(new with the §5 diff)*,
   `snapshotId`/`revision` equal the snapshot document's.
   ⇒ `tl.load.progress` phase `"manifest"` (≤ 1024 B).
6. Read every declared asset path exactly once (relative to the artifact
   root, same-origin); re-hash each against `sourceDigest`.
   ⇒ `tl.load.progress` phase `"assets"`.
7. `instantiateRuntime` with the v3 snapshot (**including `game`**),
   `settings` = the manifest's resolved `settings` (the same object to
   the runtime and the physics configuration — M3 delivery §3.3), the
   Rapier physics port, the accepted M3 module set.
8. `createSceneAdapter(canvas, { runtime, snapshot, models: { assets,
   animation: manifest.media.animation, resolveBytes } })` — the model
   prepares start (async, cancellable, §2.6).
9. `createGameHost(config)` + `mount()` — the host composes runtime +
   adapter (the adapter factory returns the created adapter; the host
   drives `renderFrame` via its `hostFrame` onFrame, unchanged). The run
   is `awaitingStart`.
10. When the model prepares settle (all ready, or a hard failure per
    §2.7): success ⇒ post **`tl.ready`** carrying the real identity
    tuple — `snapshotId`, the snapshot `revision`, the manifest
    `buildId`, the manifest `contentDigest` (64 hex), the runtime
    `stepIndex` after the settle pre-roll *(accepted §17.6 v2 ready
    shape; D-63-6: the empty-digest body is invalid and is not a
    permitted value)*. Failure ⇒ `tl.error` with the phase/code per
    §2.7.
11. On `tl.ready` the editor sends WS `play.preview.ready` ⇒ the backend
    marks the play `presented` (accepted §10.2/§13.4 step 5; D-63-4: the
    editor client must have the WS send path).

**Export (v3, standalone):** `fetch("./manifest.json")` +
`fetch("./scene.json")` (relative, digest-verified — accepted C36-1) ⇒
the §5 manifest identity check (no handshake; the manifest is the sole
identity) ⇒ read declared assets (relative, once each) ⇒
`instantiateRuntime` + `createSceneAdapter` with the `models` block ⇒
`createGameHost` + `mount()` ⇒ `awaitingStart` title screen. Ready means
the title screen loaded (the accepted §5.5 step 4 / M3 delivery §7
truth), not that gameplay started. No bridge, no `presented` state, no
authoring call (the backend may be unreachable).

**Both:** the host/adapter are created **after** the manifest identity
gates pass (no runtime before a verified identity); the model prepares
run during the `awaitingStart` window and never block the menu channel
(§4.5: start/replay/mute are serviced between frames — a user can start
the run while a decorative model is still preparing; the player's model
is required by §2.7, so a start with the player model still pending is
impossible for a well-formed capture — the wrapper posts `tl.ready`
only when the prepares have settled).

### 2.9 Graph and scan remeasurement rows (owned)

- The M3 play-preview bundle (entry `preview-m3.ts`) and the M3 export
  bundle (entry `export-bootstrap-m3.ts`) graphs **add the
  `three-adapter` `./gltf-loader` subpath** (the wrapper imports
  `createGltfLoaderPort` from the subpath to build the loader port the
  `models` block uses). The accepted `export.md` §5.4.1 **GLTFLoader
  subpath row** therefore applies per-bundle: pattern h `https://` +12,
  `GLTFLoader` ×37, d/f/j/a/b/c/e/g/i +0 (re-measured by packet 70 on
  the real bundles — any difference requests bounded re-review, never an
  exception widening).
- The M1/M2 bundles (editor `main.js`, M2 `preview.js`, M2 export) stay
  **loader-free** (root subpath only) — their recorded §5.4.1 counts are
  untouched.
- The **editor bundle** gains the `./gltf-loader` subpath only with
  packet 70-B's authoring-viewport model wiring (70-B records and
  re-measures; the M4 contract does not pre-empt 70-B's evidence).
- `game-host` adds **0** model code: the host stays model-agnostic
  (all model state lives in the adapter behind the unchanged
  `HostRenderAdapter` surface). No new package, subpath or pin; `three`
  stays `0.186.0`.

### 2.10 Fixtures (fixtures/m4/delivery)

`fixtures/m4/delivery/` (self-generated, deterministic; the committed
generator + independent checker, no dependency, no eval, no network, no
`three`) specifies the observable rendered and numeric expectations:

| File | Content |
|---|---|
| `glb/*.glb` | a rigid 3-clip positive (`Idle`/`Run`/`Airborne`, no skin, no root translation, 2 meshes) + the negative set (root-motion, skin, corrupt-truncated) + one valid GLB that is **undeclared** by the manifest (the undeclared-fetch negative) |
| `cases/model-attach-cases.json` | per-entity realization expectations: holder parenting (model root is a child of the entity holder), per-instance mixer independence (two instances, distinct roles, one weight change never touches the other), role selection at committed views (player grounded+speed ⇒ `idle`/`run`/`airborne` at the `RUN_SPEED_EPS = 0.05` boundary; non-player pinned neutral ⇒ `idle`), the crossfade weights at `t = 0.1` (`0.5/0.5`, `ANIMATION_CROSSFADE_SECONDS = 0.2`), static-on-unresolved (L6), ownership counters at baseline after repeated cancellation/dispose |
| `cases/load-order-cases.json` | the §2.8 sequence with failure injection at each phase: expected `tl.*`/on-page outcome + closed code per L1–L9; cancel-on-stop (late completion discarded), pinned reimport no-op, digest mismatch before asset reads, ready identity tuple values |
| `index.json` | byte length + SHA-256 of every data file (the checker verifies) |

The checker (`tools/check-fixtures.mjs`) independently re-derives the GLB
facts (magic/version/chunk table/clip list/skin/root-motion/channel
targets), re-verifies the `index.json` digests, re-derives the
crossfade-weight math from the accepted constants, and validates the case
files' closed-code references against the adapter/sessions closed sets.
A deliberate-corruption negative control must exit non-zero (a flipped
byte in any fixture file, or a wrong digest in `index.json`).

## 3. Queries — bounded settings values and the accepted project summary

### 3.1 The `querySettings` operation (C64-1; commands.md §2/§3.1/§5.6)

A bounded, read-only query that returns the gameplay settings **values**
at one revision. It is the only source of settings values: the editor,
the MCP and the backend share it (the accepted command/query path,
C07 "UI/MCP edits and reads share the backend command/query path").

Request (the accepted query envelope — no `expectedRevision`, no
`requestId`, never mutates, observes the last acknowledged state):

```json
{ "op": "querySettings", "projectId": "demo-0003", "args": {} }
```

`args` is absent or `{}` (any other field ⇒ `invalid_request`, the
accepted query failure code). Result:

```json
{ "ok": true, "projectId": "demo-0003", "revision": 26,
  "explicit": { "run_speed": 5 },
  "resolved": { "gravity_y": -19.62, "run_speed": 5, "jump_velocity": 7,
                "max_fall_speed": -30, "max_slope_climb_deg": 45,
                "min_slope_slide_deg": 30 } }
```

| Field | Rule |
|---|---|
| `explicit` | the `content.settings` map **as authored** (the written values only), registry key order. A v1 envelope (no `content`) ⇒ `{}`. An empty authored map ⇒ `{}` (nothing is filled in — defaults are never written into the document). |
| `resolved` | `defaults ⊕ explicit` over the **fixed M2 settings registry** (commands.md §8.11's six keys and ranges, registry order) — the same resolution the capture uses (project-model §21.5). A v1 envelope ⇒ `{}` (the M1 module set has no settings keys). Never a partial object: a resolution failure is a `field_value` error, not a partial map. |
| `revision` | the project revision the values were read at (every read carries its revision — the accepted query rule; a stale caller detects drift from the result alone). |

Bounds: ≤ 32 keys (the registry is 6; the map cap is the accepted
`settings_keys` bound). Errors: the accepted query failure set
(`project_not_found`, `project_unavailable`, `invalid_request`,
`field_value`). It is a **query**: read-only, no `requestId`, never
deduplicated, carried by the same `POST /commands` envelope (the
accepted §19.1 non-authority rule — queries are not a separate route).

### 3.2 The accepted `queryProject` content summary (C64-2; P2-B)

The accepted text (commands.md §5.6, CC-45-6 promoted at Gate L) is
binding: the `queryProject` result carries the bounded `content` summary
— v2: `{ assets, prefabs, behaviors, settingsKeys }`; a v3 state adds the
four game/content counts. The packet-63 re-verification (P2-B) shows the
implementation returns **no `content` field at all** (v2 and v3). The
diff row (C64-2) is an **additive clarification of the count semantics**
(the shape stays exactly the accepted one — no new keys, no values, no
byte lengths):

| Summary key | Exact meaning (normative) |
|---|---|
| `assets` | count of `content.assets` records |
| `prefabs` | count of `content.prefabs` records |
| `behaviors` | count of `content.behaviors` records |
| `settingsKeys` | count of authored `content.settings` keys (`0` for an empty map; `0` for a v1 envelope) |
| `game` | `content.game !== null` (boolean) |
| `zones` | number of scene entities carrying a `gameZone` component |
| `spawns` | number of scene entities carrying a `playerSpawn` component |
| `audioAssets` | number of `content.assets` records with `kind: "audio"` |

v1 envelopes carry **no** `content` field (the accepted rule — the
summary is v2+; a v1 result is byte-identical to today's shape). Counts
only: never definitions, declarations or byte lengths (the accepted rule).
Packet 71 implements the summary in the workspace query path with a
fixture assertion (the `fixtures/m2/contracts/commands/queries.json`
pattern) — the packet-64 fixture `query-cases.json` (§3.4) pins the
expected values for the committed v3 fixture.

### 3.3 Client hydration rules (no default-based guess, no second store)

- The editor settings panel **hydrates from `querySettings` on connect
  and on every resync** (reconnect, after a stale-edit retry, after
  `undo`/`redo` change records): `resolved` initializes the values;
  `explicit` marks which keys are authored non-defaults (the panel shows
  the distinction; C06 "settings hydrate from actual backend values").
  The current default-seeding fallback (client.ts:199–207) is an
  **implementation defect** under this rule and is repaired by packet 71
  (no contract change: the rule is the new §3.1 operation's purpose).
- **No second catalog, no new mutable settings store:** the panel state
  is a projection of the backend values, advanced by the same applied
  `setSettings` change records the scene projection uses (the accepted
  sessions.md §8 convergence rule; the packet-56 `gameConfig`
  projection pattern). The backend remains the sole authority; the panel
  submits only touched keys (the accepted partial `setSettings`
  semantics preserve the rest).
- **MCP parity:** `tl_content_query` (mcp-adapter) gains
  `querySettings` in its `QUERY_OPS` list and description (the tool
  routes the same envelope; same result; same revision semantics —
  C07 "agreement" holds over HTTP, WS-full-state, stdio-MCP and editor).

### 3.4 Query fixtures

`fixtures/m4/delivery/cases/query-cases.json` pins: the `querySettings`
request/result shapes (empty explicit ⇒ resolved = defaults in registry
order; one non-default key; all six keys; v1 ⇒ both `{}`; revision
carried); the error cases (unknown `args` field ⇒ `invalid_request`;
unknown project ⇒ `project_not_found`); the `queryProject` content
summary for the committed v3 fixture `fixtures/m3/storage/project-v3-demo-0003`
(expected counts re-derived by the checker from the fixture envelope:
assets = 7, `audioAssets` = the kind-audio count, `zones`/`spawns` from
the scene components, `game: true`) and for a v2 fixture (the four-key
shape, no v3 keys); the MCP `QUERY_OPS` list including `querySettings`.

## 4. Sessions — no-change adjudication (D-63-4/5/6/7 are implementation repairs)

The packet-63 bridge failures were read against the **accepted**
sessions.md text, and that text already mandates the required behavior:

| Gap | Accepted text (binding) | Defect class |
|---|---|---|
| D-63-5 (missing handshake ack) | §13.4 step 2: "the preview verifies origin/source and `playSessionId` ⇒ replies `tl.handshake.ack` (echoing `nonce`)" | implementation (the v3 wrapper omits the accepted step) |
| D-63-6 (invalid `tl.ready` body) | §17.6: "`tl.ready` gains `buildId, contentDigest, stepIndex`" — 64-hex `contentDigest` per the §13.5 validator; the manifest v2 `contentDigest` is the value | implementation (the wrapper sends `''`) |
| D-63-4 (no WS send path) | §13.4 step 5: "the editor sends WS `play.preview.ready` (the backend marks `presented`)" + step 6 `play.preview.failed`; §5.2 client heartbeat | implementation (the editor client has no send path) |
| D-63-7 (dropped `playContent`) | §17.2: the `/play` result's `playContent` + the retained `play.started` | implementation (the client merge drops the field) |

**Owned diff row C64-8 (`diffs/sessions.md`): NO contract text change.**
The record names the exact binding citations above so the Gate Q review
and packets 70/71 implement **to the accepted text** (not to a
re-statement), and so no repair is read as a contract change. The v3
wrapper's missing §18/§20 relay handler registration
(`tl.input.request`, `tl.game.control`/`tl.game.observe` + results) is
likewise an implementation repair against the accepted §18/§20 text
(packet 70).

## 5. The v3 snapshot document carries the frozen `game` block (D-63-9)

**No contract change.** The accepted runtime.md §2 already mandates the
`game` field: "v3 snapshots only, **required** … Present iff
`scene.schemaVersion === 3`; absent for v1/v2 (an unknown field on a
v1/v2 snapshot is still `snapshot_invalid`)" and "The game block travels
with the snapshot (M3)". The defect (C64-7, `diffs/runtime.md` no-change
record) is that three implementation layers have not caught up:

1. **Backend** (`backend.ts:978–988`): the retained v3 `play.started`
   snapshot document is built 4-key although `state.content.game` is
   available in the same read. Repair (packet 71, with the query work,
   or packet 70 with the bridge repair — owner choice at Gate Q): include
   `game: state.content.game` (the validated `content.game` value or
   `null`) in the v3 snapshot document. v1/v2 documents stay 4-key.
2. **Protocol type** (`protocol/src/ws-events.ts` `RuntimeSnapshotDoc`):
   gains `game?: GameConfigDoc | null` — present iff
   `scene.schemaVersion === 3` (the v3 document carries it; the runtime's
   `RuntimeSnapshot.game?: GameConfig | null` already matches).
3. **Bridge validator** (`protocol/src/bridge.ts` `tl.snapshot` case):
   the snapshot key allowlist admits `game` **iff**
   `snapshot.scene.schemaVersion === 3`; on a v1/v2 snapshot document a
   `game` field is rejected (the accepted shape rule, mirrored at the
   transport gate); `game` is a plain object or `null` — **deep shape
   validation is the runtime's** (`instantiateRuntime` re-validates per
   the accepted §2 "the producer is not trusted" rule), the bridge does
   the shape gate only, exactly as it does for `scene`. The `tl.snapshot`
   size bound (≤ 1 MiB) is unchanged: the `game` block is ≤ 16 384 B
   (the manifest `game` row bound), so a v3 snapshot still fits.

The preview's snapshot check (§2.8 step 5) gains the `gameDigest`
verification (the manifest's `gameDigest` over the snapshot's `game` —
the accepted manifest digest rule, M3 delivery §2.4), so the transport's
game value is digest-bound end-to-end.

## 6. Behavior scope and compatibility (CC-55-3)

### 6.1 The M4 delivered profile is built-in-only (explicit, not silent)

The M4 delivered game runs the **built-in module set only**: the runtime
built-ins + `platformer` + `platformer-game` (+ the M1
`thirdlight.demo:box-motion` where selected). A project whose captured
content carries a **source-bearing behavior** is rejected
**explicitly and fail-closed** at the build boundary with the accepted
codes — the closure builder's `behaviors_unsupported` (play capture and
export) and the host's `host_config_invalid`/`behaviors` (defense-in-
depth). This satisfies C14's "unsupported source-bearing behavior is not
silently omitted": the omission is a loud, coded, pre-publication
refusal that preserves the previous output (the accepted build-failure
rule), with a bounded message naming the behavior IDs (≤ 10, bounded
message). No behavior output is ever linked, fetched or executed in the
M4 profile; no script loader is introduced.

### 6.2 CC-55-3a (behavior linking) — deferred, explicitly

The behavior-linking config diff (the §3.1 `GameHostConfig` surface for
linking prepared behavior outputs) is **deferred out of M4** as an owner
scope decision (the ledger's owner table). This section records the
deferral with the accepted Gate N text restated ("no behavior-linking
channel in the §3.1 config — ACCEPTED AS OPEN") so the record chain is
unambiguous: M4 ships built-in-only with the explicit refusal above; a
later milestone may file the concrete config diff (a contract change
requiring its own gate). Nothing in M4 silently erases the support
promise or closes the item.

### 6.3 CC-55-3b (HUD/status wording) — renumbered, bounded fix in 70

The packet-55 HUD/status wording diff is renumbered **CC-55-3b** (this
ledger's split, confirmed by packet 64 as two distinct matters) and
scoped to a bounded wording fix: the export wrapper's HUD line
(export-bootstrap-m3.ts:224) is driven from the host observation cadence
(related D-63-8) and the two records' wording is reconciled so the
title/HUD lines state the same run state and sound status. Packet 70
implements and evidences it; it is tracked and closed independently of
CC-55-3a.

### 6.4 Contradictory export text — scope decision request (C64-5)

Accepted `export.md` §5.2's M3 entry block names
`packages/exporter/src/export-bootstrap-m2.ts` as the M3 page
bootstrap/wrapper. The accepted implementation — the M3 graph check
(`M3_EXPORTER_FILES = ['packages/exporter/src/export-bootstrap-m3.ts']`,
graph.ts:107), re-measured at packets 58/60 and exercised by the
packet-62 owner procedure — uses `export-bootstrap-m3.ts`, and the M3
exporter file list is **exactly one file** (`export-bootstrap-m3.ts`),
not the M2 three-file list. The proposed owned diff (C64-5) corrects the
M3 block to:

```text
packages/exporter/src/export-bootstrap-m3.ts  the M3 page bootstrap/wrapper
@thirdlight/game-host                          the shared composition + HUD/control/audio
@thirdlight/platformer-game                    the pure run/zone/camera module
```

and states the exact M3 exporter file list. **Scope decision requested
from the owner at Gate Q:** this is a clerical correction of accepted
text to match the accepted behavior (no behavior change; the M2
three-file row is untouched), or — if the owner reads the M3 entry as a
reopening of the §5.2 section — the row is deferred to a bounded
re-review. The packet-64 position: correct the text; the scan/graph
evidence of record already binds the actual bytes.

## 7. Numbered contract-change requests (resolutions recorded at Gate Q / promotion)

| # | Destination | Request | Disposition requested |
|---|---|---|---|
| CCR-64-1 (C64-1) | `commands.md` §2/§3.1/§5.6 | the `querySettings` operation (§3.1) | accept at Gate Q; implement packet 71 |
| CCR-64-2 (C64-2) | `commands.md` §5.6 | the `queryProject` content-summary count semantics (§3.2) | accept (clarification, shape unchanged); implement packet 71 (P2-B) |
| CCR-64-3 (C64-3) | `presentation.md` §41.3.6 | rule 7 clarification + non-player neutral pinning (§2.4) | accept (no frozen number changes) |
| CCR-64-4 (C64-4) | `presentation.md` §41.9 (+ the adapter closed set) | the `models` option block + `models_config_invalid`/`models_asset_unresolved` codes + `SceneAdapterDiagnostics.models` counters (§2.2/§2.5) | accept (additive, root subpath, no pin change); implement packet 69 |
| CCR-64-5 (C64-5) | `export.md` §5.2 | M3 entry row correction (§6.4) | owner scope decision at Gate Q |
| CCR-64-6 (C64-6) | `dependencies.md` §4/§5 | the M3 preview/export graph `./gltf-loader` subpath rows (§2.9) | accept; re-measured packet 70 |
| CCR-64-7 (C64-7) | `runtime.md` | no-change record: §2 already mandates `game`; D-63-9 is an implementation repair (backend/protocol/bridge) | record at Gate Q |
| CCR-64-8 (C64-8) | `sessions.md` | no-change record: §13.4/§17.6/§10.2/§5.2 already mandate the D-63-4/5/6/7 repairs | record at Gate Q |

## 8. Compatibility and non-goals

- **v1/v2 invariance:** every change here is additive to v3. v1/v2
  snapshots stay 4-key; v1 `queryProject` results stay content-less; the
  M1/M2 bundles stay loader-free with their recorded scan counts; the
  M2 preview wrapper and the M2 export entry are byte-stable.
- **No new package, subpath or pin:** the `models` surface is on the
  three-adapter root subpath; the GLTFLoader binding stays on the
  existing `./gltf-loader` subpath (packet-26 C26-1); `three` stays
  `0.186.0`; the Rapier pin is untouched.
- **No second loop, no second catalog, no new mutable store, no default-
  based guess, no behavior linking, no script loader, no second render
  path.** The single frame driver (runtime), the single command/query
  path (backend), and the single settings store (the envelope's
  `content.settings`) remain the only owners of their domains.
- **Frozen numbers unchanged:** `RUN_SPEED_EPS`, `ANIMATION_CROSSFADE_
  SECONDS`, the animation/audio/shadow limits, the six-key settings
  registry and its ranges, the manifest digest rules — all restated, none
  changed.
- **Unverified-hardware rule:** nothing in this packet claims a
  hardware-GPU, physical-input or audibility result; the packet-70
  browser evidence (SwiftShader in-container) is labelled accordingly
  (the packet-63 reference-device record stands).