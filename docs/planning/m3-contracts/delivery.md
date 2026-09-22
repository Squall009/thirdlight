**PROPOSED — not accepted.** Packet 42 (`docs/planning/m3-packets.md` §42) output.
This document proposes the M3 delivery/closure/control contract. It changes no
accepted contract: `docs/contracts/**` is binding until Gate K accepts and a
separate docs-only promotion applies the diffs in
[`diffs/sessions.md`](diffs/sessions.md), [`diffs/export.md`](diffs/export.md),
[`diffs/dependencies.md`](diffs/dependencies.md) and the packet-42 additions to
[`diffs/runtime.md`](diffs/runtime.md). Section-level diffs carry exact
destination, OLD/NEW text and supersessions; this document is the normative rule
text they point at.

Read basis (packet 42 read set): `AGENTS.md`; `docs/STATUS.md`; `m3-plan.md`
§2/§2.1/§3.1/§3.4/§5/§5.1; `m3-packets.md` rules + §42 + §48/§55/§58/§59/§60;
`m3-contracts/baseline.md` §2/§3 and `handoffs/38.md`;
`m3-contracts/{model,storage,authoring,gameplay,presentation}.md`;
`m3-sample.md` §4; `m3-acceptance.md` rows B02/B03/B16/B19/B20/B21/B23 and §1;
`m2-contracts/delivery.md` and `m2-contracts/contract-diffs.md` (house style);
accepted `runtime.md` §3.1/§14, `sessions.md` §§7/10–13/16–19, `export.md`
§§2–7, `dependencies.md` §§2/3/4.1–4.3/5/6/9, `commands.md` §5.4; the public
surfaces of `exporter`, `editor/preview`, `protocol`, `input`, `backend` play/
locator/CSP functions; handoffs 38–41.

Packet-38 evidence cited below is **evidence of record**, not re-measured here:
`docs/acceptance/evidence-m3/38/raw/engine.json`,
`…/engine-nocsp.json`, `…/engine-csp-wasm.json`, `…/summary.json`,
`…/capability.json`.

---

## 1. Scope, ownership and non-goals

This section defines the **one M3 delivery boundary**: how a captured envelope
becomes an immutable manifest v2, how one browser-safe composition runs it in
preview and export, how a player's menu controls stay separate from gameplay
input, how a bounded typed observation relay exposes run identity, and how the
static output closes over every byte it needs while declaring its own security
policy.

| Unit | Owns here | Must not |
|---|---|---|
| `project-model` | the pure manifest v2 derivation (`captureManifest`): resolved settings, the frozen `game` block, the media identity summary, the block digests and `buildId` | know about routes, locators, hosts or time beyond `capturedAt` |
| `workspace` | the single acknowledged envelope read and the immutable blob reads (accepted) | duplicate the derivation (a re-export of `captureManifest`, accepted C36-2) |
| `exporter` | the shared closure builder and the export writer/scans | a second host, a second controller or a `game-host` internal import |
| `backend` | the play/control/observe route framing, the locator serving and the relay routing (accepted shape) | implement gameplay or observation math |
| new `game-host` | the browser-safe DOM HUD, the menu/control channel, the injected audio lifecycle and the single shared production module composition | import editor/exporter internals, define gameplay rules, fetch, hold a credential |
| new `platformer-game` | the pure run-state/zone/camera module (`gameplay.md` is its contract) | concrete physics, input, DOM, three |
| `editor` | the preview wrapper: it embeds the host, injects artifacts/ports/bridge and owns the authoring transport | let the editor UI import `game-host`; a second run-state owner |
| `protocol` | every new wire shape added here, once (packet 48 implements) | a second parser |

Non-goals: a general plugin/script host, an `eval` interface, a second gameplay
bootstrap, cross-project delivery, CDN/remote audio or fonts, a server-side
browser, headless substitution for the owner browser (sessions §10.4 stays
normative), service workers, WebRTC/streaming, and any promise about audible
output, physical device support or hardware GPU behaviour.

---

## 2. Manifest v2 — the immutable runtime-content identity

The runtime-content document is **`manifest.json`**, written by a Play capture or
an export. The authoring `project.json` (`schemaVersion` 1) is a **different
document** and is not versioned by this packet (plan-review PR-4 naming rule;
packet 39's tables add only the authoring v3 rows).

### 2.1 Version decision and what stays v1

| Question | Decision |
|---|---|
| `manifestVersion` | moves **1 → 2** for M3 captures. `manifestVersion` stays **1** for every previously written manifest and for any M2 play/export path that is not re-captured. |
| Is a v1 manifest upgraded? | **No.** A v1 document remains readable under its old meaning (no `settings`/`game`/`media`, `assets` rows without `kind`, the M2 engine-pin set). An in-place upgrade is forbidden; a re-capture writes a new v2 document with a new `capturedAt`/`buildId`. |
| Why v2 and not additive? | `assets` rows gain a required `kind`, and six required keys appear. A new required field or a changed field meaning is a version change per the accepted rule (`sessions.md` §17.1.1: "A new required field or a meaning change ⇒ `2`"). |
| Authoring `project.json` | stays `schemaVersion` 1 (39 owns its v3 rows). |
| v1 consumer compatibility | A v1 reader must reject a v2 document with `manifest_invalid` (`reason: "manifest_version"`), never silently ignore the new keys: an unknown required key is a load failure, not a default. |

### 2.2 Manifest document (strict)

Canonical serialization: fixed key order (below), 2-space indent, LF, one
trailing newline, no BOM, no trailing whitespace; unknown keys ⇒
`manifest_invalid`. The committed example is
[`../../../fixtures/m3/delivery/manifest/manifest-v2-example.json`](../../../fixtures/m3/delivery/manifest/manifest-v2-example.json)
and its digest preimage is `…/manifest-v2-preimage.json`.

**Identity values are illustrative (Gate K K-5/FU-5).** The `modules`
`version`/`package` and `enginePins` `version`/`id` values in the example below
use the repository's **real** values — every `@thirdlight/*` package is
`0.1.0` (root `package.json`/`packages/*/package.json`) and the engine pin id
`@thirdlight/three` follows the accepted `sessions.md` §17.1.1 / M2 export
convention with the real lockfile `three` version `0.186.0`. They are still
**example identity values**: packet 58 derives the emitted `modules`/`enginePins`
sets from the real pin table and lockfile at build time, and the committed
`buildId` is re-derived then. No version, pin or `apiVersion` in the example is a
measured build identity.

Key order (exact):

```text
manifestVersion, type, projectId, revision, snapshotId, capturedAt,
sceneDigest, contentDigest, gameDigest, settingsDigest, mediaDigest,
settings, game, assets, media, behaviors, modules, enginePins,
recipes, toolchain, buildOptionsDigest, buildId
```

```json
{
  "manifestVersion": 2,
  "type": "thirdlight-runtime-content",
  "projectId": "demo-0001",
  "revision": 12,
  "snapshotId": "demo-0001@r12",
  "capturedAt": "2026-09-19T10:00:00Z",
  "sceneDigest": "<64 lowercase hex>",
  "contentDigest": "<64 lowercase hex>",
  "gameDigest": "<64 lowercase hex>",
  "settingsDigest": "<64 lowercase hex>",
  "mediaDigest": "<64 lowercase hex>",
  "settings": {
    "gravity_y": -19.62, "run_speed": 4, "jump_velocity": 7,
    "max_fall_speed": -30, "max_slope_climb_deg": 45, "min_slope_slide_deg": 30
  },
  "game": null,
  "assets": [
    { "assetId": "asset-0001", "kind": "model", "version": 2,
      "sourceDigest": "<64 hex>", "sourceByteLength": 1864,
      "recipeDigest": "<64 hex>", "metricsDigest": "<64 hex>",
      "path": "content/sha256/<64 hex>" },
    { "assetId": "asset-0002", "kind": "audio", "version": 1,
      "sourceDigest": "<64 hex>", "sourceByteLength": 48044,
      "recipeDigest": "<64 hex>", "metricsDigest": "<64 hex>",
      "path": "content/sha256/<64 hex>" }
  ],
  "media": {
    "cues": { "start": { "assetId": "asset-0002", "version": 1 },
              "jump": null, "checkpoint": null, "death": null, "goal": null },
    "animation": [
      { "entityId": "player-0001", "assetId": "asset-0001", "version": 2,
        "profileDigest": "<64 hex>",
        "roles": { "idle": { "clipIndex": 0, "clipName": "Idle" },
                   "run": { "clipIndex": 1, "clipName": "Run" },
                   "airborne": { "clipIndex": 2, "clipName": "Airborne" } } }
    ]
  },
  "behaviors": [],
  "modules": [
    { "id": "thirdlight.platformer-game:session", "apiVersion": 1,
      "package": "@thirdlight/platformer-game", "version": "0.1.0" },
    { "id": "thirdlight.platformer:controller", "apiVersion": 1,
      "package": "@thirdlight/platformer", "version": "0.1.0" }
  ],
  "enginePins": [
    { "id": "@thirdlight/platformer-game", "version": "0.1.0", "apiVersion": 1 },
    { "id": "@thirdlight/runtime", "version": "0.1.0", "apiVersion": 2 },
    { "id": "@thirdlight/three", "version": "0.186.0", "apiVersion": 0 }
  ],
  "recipes": { "behavior-source": 1, "gltf-glb": 1, "pcm-wav": 1 },
  "toolchain": { "esbuild": "0.28.2", "typescript": "5.9.3",
                 "optionsDigest": "<64 hex>" },
  "buildOptionsDigest": "<64 hex>",
  "buildId": "<64 hex>"
}
```

### 2.3 Field rules (v2 additions in bold)

| Field | Rule |
|---|---|
| `manifestVersion` | exactly `2`. |
| `type` | exactly `"thirdlight-runtime-content"`. |
| `projectId` / `revision` / `snapshotId` / `capturedAt` | unchanged from v1 (`snapshotId = <projectId>@r<revision>`; `capturedAt` is a UTC second and **is** a `buildId` input, C36-7). |
| `sceneDigest` | unchanged: SHA-256 of the canonical scene bytes at the captured revision. |
| `contentDigest` | unchanged: SHA-256 of the canonical captured content view (`{assets, prefabs, behaviors, settings, behaviorTrust, game}`). |
| **`gameDigest`** | SHA-256 of the canonical serialization of the `game` value; `game: null` hashes the four bytes `null`. |
| **`settingsDigest`** | SHA-256 of the canonical serialization of `settings`. |
| **`mediaDigest`** | SHA-256 of the canonical serialization of `media`. |
| **`settings`** | the **resolved** six-key gameplay settings (`defaults ⊕ content.settings`, `project-model.md` §21.5). Keys in registry order; exactly the six known keys; a resolution failure at capture ⇒ `game_config_invalid`/`field_value`, never a partial object. |
| **`game`** | the frozen `content.game` value (39 §23.4) or `null`; canonical `GameConfig` key order; ≤ 16 384 canonical bytes (39 §23.10 `game_bytes`). Embedded, not a side-car file: the manifest stays the single structural input. |
| **`assets`** | unchanged ordering/version rules **plus a required `kind ∈ {"model","audio"}`** matching the captured `AssetRecord`; a mismatch ⇒ `asset_kind_mismatch`. `path` is always `content/sha256/<sourceDigest>`. |
| **`media`** | the resolved media identity: `cues` (the five game cues resolved to `{assetId, version}` or `null`, ascending key order `start, jump, checkpoint, death, goal`) and `animation` (one row per `modelAnimation` entity, ascending by `entityId` then `assetId`). Each animation row carries the **immutable** `(assetId, version)`, the `profileDigest` of its canonical `roles` bytes and the validated `roles` map. It exists so the loader verifies cue/role identity against bytes **without** re-reading the project (the C35-2 rationale). It must equal the captured content's resolution exactly; a disagreement ⇒ `manifest_invalid` (`reason: "media_identity"`). |
| `behaviors` / `modules` / `enginePins` / `recipes` / `toolchain` | v1 rules unchanged, with the M3 additions: `recipes` gains `pcm-wav: 1` (41) and the `modules`/`enginePins` sets gain the new units; still ascending by `id`. |
| `buildOptionsDigest` | unchanged (`delivery` §4.2 record). |
| `buildId` | unchanged rule over the **v2** key order: SHA-256 of `JSON.stringify(manifestWithoutBuildId, null, 2) + "\n"` UTF-8. |

### 2.4 Digest preimage and canonical ordering (normative)

1. **Block digests** hash the canonical serialization of the block value:
   `sha256(JSON.stringify(value, null, 2) + "\n")`, UTF-8, key order as declared
   by the owning contract (settings: registry order; `game`: 39 §23.4; `media`:
   the order above). A `null` value hashes its own four canonical bytes.
2. **`buildId`** hashes the whole manifest without `buildId`, canonical key order
   with `buildId` last. Because `settings`, `game` and `media` are inside that
   preimage, every runtime-affecting authored value is **hash-bound** through
   `buildId`; the block digests exist so a consumer can verify one block against
   its declared identity without re-serializing the document.
3. **No map order, no clock, no locale** may affect any block: `settings` and
   `game` come from one envelope read; `media` is a deterministic projection of
   the same read; the assets/behaviors orderings are the accepted codepoint
   orderings. The only clock input is `capturedAt`.
4. `buildId` is **not** an engine-independent binary hash (accepted identity rule
   restated); `snapshotId`, `buildId` and the export `outputDigest` stay three
   distinct values and are never presented as interchangeable.

### 2.5 `capturedAt` reproducibility rule (M3 restatement)

The accepted rule is unchanged and extended by the M3 keys:

- Reproducibility is checked by exporting/capturing **twice into two separate
  output trees** and hashing each tree **before any overwrite**.
- Only the contracted **timestamp carriers** are normalized: `capturedAt` in
  `manifest.json` and `exportedAt` in `meta.json`. Nothing else is normalized.
- `buildId` is **re-derived** after normalization; the two trees must then be
  byte-identical.
- The M3 additions (`gameDigest`, `settingsDigest`, `mediaDigest`, `settings`,
  `game`, `media`) are timestamp-free and must be **identical without
  normalization**; they are listed in the reproducibility fixture's
  `neverNormalized` set. Two captures in the same second are byte-identical apart
  from `meta.json.exportedAt`; captures in different seconds differ additionally
  in `capturedAt` and `buildId` (accepted C36-7 wording, unchanged).

### 2.6 Late edit/reimport and failed/cancelled builds

- **One capture, one read.** `captureManifest` consumes the scene, `content.game`
  and `content.settings` from **one acknowledged envelope state** (accepted
  §17.1.3), and the backend re-reads the revision before publishing. A change ⇒
  `export_snapshot_mismatch` / the play-start `revision_conflict`; never a mixed
  manifest.
- **Late edit.** An authoring edit after capture produces a **different**
  `snapshotId`; it cannot alter the pinned manifest. A running Play keeps its
  frozen snapshot (accepted §10.2), so a later settings/game/media edit is
  invisible to it (§3.5).
- **Late reimport.** A reimport is one atomic revision (41 §41.3.4) that produces
  a new asset version. A manifest captured before it names the old
  `(assetId, version, profileDigest)` triple; a manifest captured after it names
  the new triple. There is **no state** in which a v2 manifest names a role map
  from one version and asset bytes from another: both come from the same captured
  content view and the same `(assetId, version)`.
- **Failed or cancelled build.** No partial manifest is ever published: the
  manifest is written at the same instant as the complete artifact set it names
  (accepted §17.1.3 rule 5). A failed build writes nothing, leaves the previous
  immutable artifact and its locator served, and leaves the publication that
  triggered it untouched. A **cancelled Play load** (stop during load) aborts
  in-flight artifact reads, disposes, reports no `presented`, and does not change
  the previous Play's pinned artifact set or bytes (§7.4).
- **No mixed bytes**: because the manifest is self-identifying and every declared
  path carries its own digest, a reader that finds a digest mismatch fails
  (`blob_corrupt`/`manifest_invalid`) rather than assembling a working set from
  two captures.

---

## 3. One shared public composition entry

### 3.1 The `game-host` public surface (browser-safe)

New unit `@thirdlight/game-host`, public subpath `.` only:

```ts
export const GAME_HOST_API_VERSION = 1;

export type GameControlAction = 'start' | 'replay' | 'mute' | 'unmute';
export const GAME_CONTROL_ACTIONS: readonly GameControlAction[] =
  ['start', 'replay', 'mute', 'unmute'];
export const GAME_HOST_MESSAGES: readonly string[] =
  ['tl.game.control', 'tl.game.observe',
   'tl.game.control.result', 'tl.game.observe.result'];

export interface GameHostConfig {
  /** The frozen runtime snapshot (runtime.md §2, v3). */
  snapshot: unknown;
  /** The resolved six-key settings from manifest v2 (§2.3); passed through to `instantiateRuntime`. */
  settings: Readonly<Record<string, number>>;
  /** The injected physics port (a real Rapier adapter in production). */
  physics: unknown;
  /** The injected scene adapter (three realization; the host never imports three). */
  adapter: unknown;
  /** The injected browser input owner (`attachBrowserInput`; one owner only). */
  input: unknown;
  /** The injected audio interface (presentation.md §41.4.7). */
  audio: unknown;
  /** The injected artifact reader (manifest-declared relative paths only). */
  readArtifact: (path: string) => Promise<ArrayBuffer>;
  /** The DOM container for the HUD (plain text nodes and buttons). */
  container: unknown;
}

export interface GameHostObservation {
  runId: string; snapshotId: string; buildId: string;
  stepIndex: number; state: string; checkpointId: string | null;
  deathCount: number; goalReached: boolean; failed: boolean;
  sound: { status: 'muted' | 'blocked' | 'ready' | 'unavailable';
           unlocked: boolean; voices: number; muted: boolean;
           gesture: 'local' | 'none' };
  inputMode: 'physical' | 'test';
}

export interface GameHost {
  mount(): { ok: true } | { ok: false; error: { code: string } };
  control(action: GameControlAction): { ok: true; state: string; acceptedAtStep: number }
    | { ok: false; error: { code: string; reason?: string } };
  observe(): { ok: true; observation: GameHostObservation };
  setViewport(width: number, height: number): { ok: boolean; error?: { code: string } };
  dispose(): void;
}

export function createGameHost(config: GameHostConfig): GameHost;
```

Rules:

- The host is **browser-safe by construction**: it imports `runtime`,
  `platformer`, `platformer-game`, `input` and `three-adapter` **types** (plus
  the accepted `instantiateRuntime`/registry and `attachBrowserInput` values);
  it imports **no** editor, exporter, backend, workspace, commands, protocol,
  `mcp-adapter`, `asset-pipeline`, `behavior-build` or Node builtin module and
  **no** concrete `physics-rapier`/`three` module (§3.4).
- It performs **no fetch and holds no credential**: artifact bytes enter only
  through the injected `readArtifact` (the wrapper owns the locator/relative
  reads), exactly as the accepted adapter rule requires (`three-adapter` gets
  bytes or a resolver).
- HUD text (`title`/`objective`/`instructions` from the frozen `content.game`) is
  inserted as **text nodes**, never project-supplied HTML; the checkpoint bit is
  read from the committed `GameView` (`presentation.md` §41.5.2); the HUD owns no
  checkpoint-activation appearance (41/52).
- `dispose()` removes listeners, DOM, mixer and audio voices it owns,
  idempotently; a new host for the same snapshot re-uses the wrapper's adapter/
  audio resources (41 §41.6 ordering).

### 3.2 What the host owns, and what it does not

| Owns | Does not own |
|---|---|
| DOM HUD (title/objective/instructions/checkpoint/deaths/sound status), plain buttons | gameplay rules (`platformer-game`), physics (`physics-rapier`), rendering (`three-adapter`) |
| the menu/control channel and `gameCommand('start'|'replay')` submission (§4) | the continuous `ActionFrame` mapping (`input`) |
| the injected audio lifecycle and mute state (§4.3) | decoding/inspection (`asset-pipeline`), the audio bytes |
| the **single** production module composition: registry (`runtime` built-ins + `platformer` controller + `platformer-game` session + linked behavior modules), `instantiateRuntime`, the frame-driver wiring and disposal | a second bootstrap, a second controller/runtime, a second run-state owner |
| viewport resize pass-through (`Runtime.setViewport`) | camera math (`platformer-game`), renderer resize policy (`three-adapter`) |

**No duplicate gameplay bootstrap (normative).** `game-host` is the *only*
place the M3 module set, registry and host update loop are assembled.
`packages/editor/src/preview/preview-bootstrap.ts` and the export bootstrap
become **thin wrappers** that build the platform specifics (page config, locator
reads, canvas, physics adapter, audio implementation, bridge) and call
`createGameHost`. The M2 composition currently in
`packages/exporter/src/export-composition.ts` is **not** imported by the host:
packet 58 moves/reuses that wiring behind the public `game-host` entry, and the
runtime bundles must not contain exporter internals (§3.4, `diffs/export.md`).

### 3.3 Closing C35-5 — authored settings reach the controller **and** physics

The accepted `runtime.md` §3.1 note defers `content.settings` and records the
proposed diff. This packet closes it exactly as recorded there:

1. **Capture.** `captureManifest` resolves `content.settings` through the accepted
   `resolveGameplaySettings(content) → ModelResult<GameplaySettings>` from the
   same single envelope read, and emits it as `settings` + `settingsDigest`
   (§2.3). An invalid key/value fails the capture; there is no "best effort"
   resolution and no second read.
2. **Runtime.** Both wrappers pass the manifest's `settings` object into
   `instantiateRuntime({ …, settings })`; the runtime resolves it against the
   six-key defaults (a present key wins), deep-freezes it and exposes it as
   `StepContext.settings`, which is the **only** channel the controller reads
   (`platformer` reads `settings.run_speed`, `settings.jump_velocity`, …).
3. **Physics configuration.** The wrappers build the Rapier world from the
   **same in-memory resolved object** — `gravity_y` is the configured gravity
   vector — and never re-read `content.settings` from the envelope or the
   snapshot. One object, two consumers; a disagreement between the runtime
   settings and the physics gravity is a host bug, not a contract state.
4. **Hash binding.** `settingsDigest` and `buildId` cover the resolved values, so
   two builds that differ only in `run_speed` have different `settingsDigest`,
   `contentDigest` and `buildId` (and identical `sceneDigest`, `gameDigest`,
   `mediaDigest`). `export.md` §5.4.1 is unchanged: settings are not bytes and add
   no scan pattern.
5. **B16 numeric comparison** (defaults vs a changed setting; the acceptance row
   fixes the observable, not the internal path):

   | Observation | Defaults | Changed | Unit / tolerance |
   |---|---|---|---|
   | controller target horizontal speed with `moveX = 1` from rest, settled | `run_speed` = 4 | `run_speed` = 6 | m/s; same build `≤ 1e-6` |
   | controller displacement over a 240-step window after the acceleration ramp | ∝ 4 | ∝ 6 | m; recorded difference ≫ tolerance |
   | physics free-fall `vy` after 120 / 240 steps (`g·N/SIM_HZ`, `SIM_HZ 120`) with `gravity_y` | −19.62 / −39.24 | −30 / −60 | m/s; `≤ 1e-6` |

   The fixture records the two settings, the two derived digests and the
   arithmetic relation (`manifest/variants/settings-variant.json`); packet 58
   measures the production composition and packet 60 repeats it through the
   export bundle. **No numeric claim is made here** — a fixture is a contract
   identity, not a measurement.

6. **An active pinned run is unaffected by a later authoring edit.** A run's
   runtime snapshot and manifest are frozen at start (accepted §10.2). A later
   `setSettings` advances the authoring revision (`r12 → r13`) and produces a new
   `snapshotId`/`buildId`; the pinned Play keeps `snapshotId r12`, its `buildId`,
   its `runId`, its resolved `run_speed`/`gravity_y` and its locator bytes
   unchanged, and its `stepIndex` continues. A fresh Play adopts the new capture.
   There is no live settings reload and no mid-run mutation path
   (`fixtures/m3/delivery/settings/pinned-run.json`).

### 3.4 Dependency rows for `platformer-game` and `game-host` (Gate K material)

Plan-review PR-5 requires Gate K to accept these rows explicitly. They are also
in [`diffs/dependencies.md`](diffs/dependencies.md) and
`fixtures/m3/delivery/deps/dependency-rows.json`.

**`dependencies.md` §2 (units).** Add, created only in their implementation
packets (49 and 55/58):

| Unit | Implements (contract) | Packet | Responsibility (normative boundary) |
|---|---|---|---|
| `platformer-game` | `gameplay.md` | 49 | pure run state, swept zone geometry and camera math over runtime ports/types; no concrete physics, input, DOM or three |
| `game-host` | this document §§3–5 | 55 | browser-safe DOM HUD, menu/control consumption, injected audio lifecycle and the single shared production module composition; no editor/exporter internals |

**`dependencies.md` §3 (public surface).**

| Unit | Public subpaths |
|---|---|
| `platformer-game` | `.` → `platformerGameSessionSpec`, `platformerGameCameraSpec`, `PLATFORMER_GAME_MODULE_ID`, `stepZones`, `zoneOverlap`, `followCamera`, `CAMERA_CONSTANTS`, `RUN_LIMITS` |
| `game-host` | `.` → `createGameHost`, `GAME_HOST_API_VERSION`, `GAME_HOST_MESSAGES`, `GameHostConfig`, `GameHostObservation`, `GAME_CONTROL_ACTIONS` (the §3.1 surface; internal files are unreachable) |

**`dependencies.md` §4.1 (node-side import edges).**

| Package | Allowed edges |
|---|---|
| `platformer-game` | `runtime` (types) — pure, no other project edge |
| `game-host` | `runtime` (types + `instantiateRuntime`/registry values), `platformer`, `platformer-game`, `input` (types + `attachBrowserInput` value), `three-adapter` (**types only**: the adapter/resource interfaces and the injected byte resolver) |

**`dependencies.md` §4.2 (bundle graphs).** The play-preview and export bundle
graphs gain `game-host` + `platformer-game`; the editor bundle is unchanged. All
four runtime-bundle prohibitions are unchanged: no `backend`, `workspace`,
`commands`, `mcp-adapter`, `exporter` internals, `behavior-build`,
`asset-pipeline`, editor internals or Node builtin may appear.

**`dependencies.md` §4.3 (forbidden edges).**

- `platformer-game → input | physics-rapier | three | three-adapter | runtime concrete adapters | editor | backend | workspace | commands | protocol | DOM | Web Audio`.
- `game-host → editor (any subpath) | backend | workspace | commands | protocol | mcp-adapter | exporter (any subpath) | asset-pipeline | behavior-build | physics-rapier (concrete) | three (direct) | Node builtins`.
- **Editor UI rule (normative, PR-5):** `packages/editor/src/ui/**`,
  `packages/editor/src/session/**` and `packages/editor/src/viewport/**` may
  **not** import `@thirdlight/game-host`; only `packages/editor/src/preview/**`
  (the preview wrapper) may. Without this rule §4.2's `editor/**` wildcard would
  pull DOM and Web Audio into the editor bundle.

**`dependencies.md` §5 (checks).** Check 1 must fail a probe where
`packages/editor/src/ui/**` imports `@thirdlight/game-host`; check 3 must fail if
`game-host`/`platformer-game` appears in the editor bundle or if exporter
internals appear in a runtime bundle. Probes are disposable.

**`export.md` §5.4.1 fetch/graph re-measurement (normative).** Packets **58 and
60** must re-measure the changed §5.4.1 counts and the §17.5 fetch list on the
real bundles. The intended change is **zero**: `game-host` performs no fetch and
the M3 keys add no side-car file, so the count stays
`1 + |unique declared artifacts|` plus the accepted exception rows. If the
measured text differs, 58/60 record the measurement and request bounded
re-review; they never widen an exception.

---

## 4. Frame/menu control separation and the input contract

### 4.1 Two channels, one input owner

| Channel | Content | Owner | Bindings |
|---|---|---|---|
| **gameplay** | the accepted per-step `ActionFrame` (`moveX`, `jump`) | `input` (`attachBrowserInput` + `createStepInputSource`) | unchanged M2 bindings: A/D, arrow left/right, Space; pad axis 0 / D-pad 14–15 / button 0 (0.2 radial dead zone; deterministic keyboard → D-pad → stick arbitration) |
| **menu** | the bounded semantic actions `menuConfirm`, `mute` | `game-host` consumes the input owner's menu sample | `Enter` **or** `Space` **or** a fresh primary gamepad button (button 0) → `menuConfirm`; `KeyM` → `mute` toggle |

Rules:

- The menu channel is **separate**: a menu action never enters a runtime
  `ActionFrame`, and `Enter` is not a gameplay binding (packet-38 probe:
  `Enter → unbound`). `game-host` maps `menuConfirm` onto
  `Runtime.gameCommand('start')` in `awaitingStart` and `'replay'` in `won`; in
  every other run state `menuConfirm` is consumed and does nothing.
- `start`/`replay`/`mute`/`unmute` are exactly `GAME_CONTROL_ACTIONS`; the relay
  (§5) and the local menu produce the same semantic action. Mute is a
  **browser-session preference**: not authoring state, not in the snapshot, not
  persisted.
- **One owner only.** No second gamepad poller, no second frame driver, no
  competing sampling loop.

### 4.2 Fresh release, and no phantom jump

A consumed menu press **must be released** before it can become a jump:

```text
idle --press--> consumed(needsRelease) --release--> idle
```

`consumed(needsRelease)` suppresses both a jump frame and a second `menuConfirm`
from a re-report of the same held button; it clears on release, on disconnect and
on focus/visibility loss. Combined with `gameplay.md` §2.5's first-live-step jump
gate, **held Start at the title cannot produce a phantom jump** (fixture case
`C1`): Start is consumed, the run starts with a neutral frame, and no jump is
emitted until a release-then-press cycle occurs (case `C2`).

### 4.3 Gamepad takeover, disconnect and denial

- Takeover uses the accepted deterministic arbitration; a gamepad moving becomes
  the active source without summation and without a second poller.
- Disconnect (or index reuse) clears held menu and movement state from that
  device immediately; keyboard play is unaffected and no control stays stuck
  (case `C7`).
- If `navigator.getGamepads()` is absent, blocked or denied (including an iframe
  without `allow="gamepad"`, packet-38 measured `SecurityError`), the binding
  reports its accepted structured unavailable state; keyboard play continues and
  no fallback owner is created (case `C8`).

### 4.4 Exclusive injected/test mode; no fake user activation

- The accepted §18 relay sets the runtime input mode to `test`. While it is
  active: physical sampled frames **and** the physical menu channel are ignored,
  so an injected sequence cannot race a physical press (case `C9`; overlap ⇒
  `input_relay_conflict`). The mode clears on completion, stop, preview
  disconnect and locator expiry, re-arming the physical source from a neutral
  frame (accepted rule).
- **Injected input is never a trusted user gesture.** A `postMessage`- or
  relay-originated action cannot resume a suspended `AudioContext`, cannot
  unlock audio, and cannot report `running`: with no local gesture the host's
  sound status is `blocked` (`unlocked: false`) and the relay result never
  fabricates a `ready`/`running` sound state (case `C10`; `presentation.md`
  §41.4.7's local-gesture rule is unchanged).

### 4.5 Controls while no physics tick is driven

At `awaitingStart` and `won` the runtime executes **no movement steps**
(`gameplay.md` §2.2). The host must therefore service the menu/control channel
**between** frames, never by waiting for a tick: `gameCommand` is callable
between frame updates and rejects a re-entrant call (`phase_violation`). Cases
`C4`/`C5`: Start at the title and replay at the win screen both succeed with
`movementSteps: 0`. The title/win HUD states the controls and the sound status.

### 4.6 Loss of focus/visibility

On `blur`, `visibilitychange → hidden` or `pagehide` the input owner suspends
sampling and clears every held key/button and the menu latch; the host suspends
audio; and the host **resets its accumulated frame time** so a resume cannot
fast-forward hazards or replay a stale edge. The accepted bounded catch-up
(`MAX_CATCHUP_STEPS = 8`) and drop-and-resync rule then make the first frame
after resume a **fresh anchor**: no wall-clock replay, no phantom actions, no
catch-up burst (case `C11`). This does not change M1/M2 step math, which stays
byte-identical.

---

## 5. Typed observation relay and SDK tool

Packet 48 implements the wire validators and the MCP tools; packet 59 wires the
preview. This section is the contract both consume. All shapes are **strict**:
unknown fields ⇒ `field_unexpected`, missing required ⇒ `field_missing`.

### 5.1 Control request/result

```jsonc
// POST /api/v1/projects/:projectId/play/:playSessionId/control
// authoring origin + project bearer token or admin scope
{ "command": "start", "expectedRunId": "demo-0001@r12#0" }
```

| Field | Rule |
|---|---|
| `command` | one of `start`, `replay`, `mute`, `unmute`; anything else ⇒ `field_value` |
| `expectedRunId` | optional optimistic guard; shape `<snapshotId>#<replayEpoch>`; a mismatch ⇒ `game_run_stale` (409, `conflict`, carrying the current `runId`) and **no** command is applied |

```jsonc
{ "ok": true,
  "playSessionId": "play-…", "snapshotId": "demo-0001@r12",
  "buildId": "<64 hex>", "runId": "demo-0001@r12#0",
  "command": "start", "state": "playing", "acceptedAtStep": 0,
  "inputMode": "physical" }
```

`ok: true` reports acceptance of the **submission** (the runtime's own rule);
`state` is the run state at acceptance. A command invalid for the state ⇒
`game_command_invalid` (`reason: "state"`). `mute` reports the resulting sound
status in the next observation; it never reports `running` from an injection.

### 5.2 Observation request/result

```jsonc
// POST /api/v1/projects/:projectId/play/:playSessionId/observe
{ "timeoutMs": 5000 }        // 250..15000, default 5000
```

```jsonc
{ "ok": true,
  "playSessionId": "play-…", "snapshotId": "demo-0001@r12", "revision": 12,
  "buildId": "<64 hex>", "runId": "demo-0001@r12#0",
  "stepIndex": 1531, "simTime": 12.758333333333333, "state": "playing",
  "checkpointId": "zone-0004", "checkpointActive": true,
  "deathCount": 1, "goalReached": false,
  "eventCount": 3, "eventDropped": 0, "failed": false,
  "inputMode": "physical",
  "sound": { "status": "ready", "unlocked": true, "voices": 1,
             "muted": false, "gesture": "local" },
  "events": [ /* ≤ 32, oldest first; the committed GameView events */ ],
  "observedAt": "2026-09-19T10:00:03Z" }
```

- The values are **read from the committed read-only `GameView`** (`gameplay.md`
  §6) and the injected audio owner; `protocol`/`backend`/`mcp-adapter` perform no
  gameplay or observation math. `sound.status ∈ {muted, blocked, ready,
  unavailable}`; `gesture ∈ {local, none}`.
- Bounds: request body ≤ 4096 B; result ≤ 16 384 B; `events` ≤ 32 with the
  accepted `MAX_GAME_EVENTS` bound and the cumulative counters.
- MCP surface: tool `tl_game_control` (control request/result) and tool
  `tl_game_observe` (observation request/result), both routed through the
  existing backend services and the play session's selected browser — never a
  server-side simulation.

### 5.3 Run identity and staleness

The identity tuple is
`(playSessionId, snapshotId, buildId, runId, stepIndex)`:

| Field | Meaning |
|---|---|
| `playSessionId` | the backend play record (accepted §10.1) |
| `snapshotId` | `<projectId>@r<revision>` (runtime.md §2) |
| `buildId` | the manifest v2 `buildId` (§2) |
| `runId` | `${snapshotId}#${replayEpoch}` (gameplay.md §6) |
| `stepIndex` | the published `GameView.stepIndex` |

Staleness is detectable without a second channel:
`view.runId !== current.runId` (another run/replay),
`view.stepIndex < current.stepIndex` (older publication),
`view.snapshotId !== play.snapshotId` (stale capture) and
`view.buildId !== manifest.buildId` (stale build). A host never mixes views from
two runtime instances (gameplay.md §6). A stale **control** is refused
(`game_run_stale`); a stale **observation** is reported with its own identity so
the caller decides.

### 5.4 Failure semantics (closed set)

| Condition | Code | HTTP | cls |
|---|---|---|---|
| malformed/unknown command or field | `field_value` / `field_unexpected` | 400 | `validation` |
| command invalid for the run state | `game_command_invalid` (`reason: "state"`) | 400 | `validation` |
| `expectedRunId` mismatch | `game_run_stale` | 409 | `conflict` |
| unknown/stopped play | `play_not_found` | 404 | `not_found` |
| locator TTL elapsed | `play_locator_expired` | 503 | `unavailable` |
| wrong origin | `bad_origin` | 403 | `validation` |
| wrong bridge source or nonce | `game_relay_rejected` (dropped and counted) | 503 | `unavailable` |
| postMessage mistaken for activation | never accepted; sound stays `blocked` | 200 | — |
| no registered browser / owner WS detached | `session_unavailable` | 503 | `unavailable` |
| play exists but not `presented` | `session_unavailable` (`reason: "not_presented"`) | 503 | `unavailable` |
| no `tl.game.result` within `timeoutMs` | `game_relay_timeout` | 503 | `unavailable` |
| physical input engaged during exclusive test mode | `input_relay_conflict` | 409 | `conflict` |
| payload over a bound | `limits_exceeded` (`result_bytes`) | 400 | `validation` |

**Nothing binary or sensitive ever crosses.** A relay request, result, bridge
message or log entry carries **no** GLB/WAV bytes, **no** base64 media, **no**
authoring token, **no** `contentId` capability (redacted as
`<redacted:contentId>`), **no** absolute workspace path and **no** generic
eval/script field. Audio is referenced by `assetId` only (C41-5); bytes are
loaded from the immutable blob/locator path by the preview itself.

---

## 6. Static closure and serving

### 6.1 Preview CSP — the C38-1 diff (owned here)

The accepted preview-origin policy (`sessions.md` §17.4; implemented verbatim in
`packages/backend/src/backend.ts`) blocks the pinned Rapier WASM in a real
browser. Packet-38 raw evidence:

| File | Result |
|---|---|
| `evidence-m3/38/raw/engine.json` | `physicsOk: false`; `wasmCompile` blocked because `'unsafe-eval'`/`'wasm-unsafe-eval'` is not allowed for `script-src 'self'` |
| `evidence-m3/38/raw/engine-nocsp.json` | `physicsOk: true` (no CSP) |
| `evidence-m3/38/raw/engine-csp-wasm.json` | `physicsOk: true` (**production CSP + `'wasm-unsafe-eval'`**) |

Accepted text exactly as it reads today:

```text
default-src 'none'; script-src 'self'; connect-src 'self';
img-src 'self' data:; style-src 'self'; font-src 'none'; worker-src 'none';
object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors <exact authoringOrigin>
```

Exact replacement (one token added; nothing removed):

```diff
-  default-src 'none'; script-src 'self'; connect-src 'self';
+  default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';
```

Consequences recorded with the diff:

- `'wasm-unsafe-eval'` permits **WebAssembly compilation only**; it does **not**
  permit `eval`, `new Function` or arbitrary script evaluation. No `eval`
  interface is added anywhere.
- The implementation builds the header as
  `"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'" + (nonce ?
  " 'nonce-…'" : "") + "; connect-src 'self'; …"`; the token applies to the shell
  and artifact responses alike, and the existing nonce clause is unchanged.
- A separately emitted `.wasm` artifact, if ever produced, keeps the accepted
  `scanWasmContainer` validation, `application/wasm` MIME and an empty host-import
  allowlist; the Rapier pin inlines its WASM, so no new artifact class is
  introduced here.

### 6.2 Iframe framing — the C38-2 requirement

Every play iframe embedding (the editor preview wrapper and the M3 locator shell)
carries **`allow="gamepad"`**. The accepted `sessions.md` §13.1 requirement
(C30-5) is confirmed by packet 38: with `allow="gamepad 'none'"`,
`navigator.getGamepads()` throws a `SecurityError` (permissions policy), so the
gamepad half of the acceptance rows is unreachable without the attribute. If a
`Permissions-Policy` header is ever added, it must delegate `gamepad`; the
attribute remains required regardless.

### 6.3 MIME, cache and serving rules

| Class | `Content-Type` |
|---|---|
| `.html` | `text/html; charset=utf-8` |
| `.js` | `text/javascript; charset=utf-8` |
| `.json` | `application/json` |
| `.wasm` | `application/wasm` |
| `.glb` | `model/gltf-binary` |
| `.wav` | `audio/wav` |

- `X-Content-Type-Options: nosniff` on every response; no content sniffing.
- Preview-origin artifacts keep the accepted `Cache-Control: private, immutable`
  with `max-age` ≤ the remaining locator TTL, plus `ETag: "<digest>"`; a reload
  inside the capability resolves to the **same bytes**, never newer content.
- The **export declares its own policy** and does not rely on any hosting header:
  `index.html` carries a `<meta http-equiv="Content-Security-Policy">` with
  `default-src 'none'`, `script-src 'self' 'wasm-unsafe-eval'`,
  `connect-src 'self'`, `img-src 'self' data:`, `style-src 'self'`,
  `font-src 'none'`, `worker-src 'none'`, `object-src 'none'`,
  `base-uri 'none'`, `form-action 'none'`. `frame-ancestors` is **omitted**: it is
  ignored in a meta policy and the export is never framed by the engine.

### 6.4 Non-root static path closure (standalone export)

- The M3 export tree (`<exportRoot>/<projectId>@r<revision>/`) is the accepted
  layout plus the v2 `manifest.json`; the M3 keys add **no** side-car file.
- Every reference is **relative** (`./manifest.json`, `./scene.json`,
  `./js/main.js`, `./content/sha256/<digest>`) so the same tree is servable under
  a non-root prefix (acceptance example `/games/beacon-reach/`). No leading-`/`
  reference, no `<base>` element, no absolute path, no `file://`, no
  `http(s)://`, no CDN/font/audio URL.
- **Declared == emitted**: every declared artifact is present and every present
  artifact is declared (accepted §9 restated), including model and audio bytes.
- No authoring credential, locator capability, absolute workspace path, Node
  import, MCP/backend call or compiler is reachable from the output; the backend
  may be stopped or unreachable.

### 6.5 Scan/graph rows the new edges change

- **Fetch list (intended change: none).** `game-host` performs no fetch; the
  manifest stays the single structural read; `game` is embedded so there is **no
  `game.json` side-car** and no extra fetch. The preview/export fetch set stays
  `./manifest.json`, `./scene.json` (export) and one read per unique declared
  asset path; count `1 + |unique declared artifacts|`.
- **`export.md` §5.4.1 (intended change: none).** The pinned `three@0.186.0`
  rows, the GLTFLoader subpath row, the Rapier `fetch(` row and the trust-notice
  row are unchanged. `game-host` adds **0** occurrences for patterns a/b/c/e/g/i
  and 0 additional for d/f/h/j; Web Audio (`new AudioContext`) is **not** a
  scanned pattern (`j` covers `XMLHttpRequest`/`WebSocket` only). No blanket
  allowance and no new exception row are proposed.
- **Graph rows.** The play-preview and export bundle graphs gain `game-host` and
  `platformer-game`; the editor bundle must not contain `game-host`; the runtime
  bundles still exclude `backend`/`workspace`/`commands`/`mcp-adapter`/exporter
  internals/`behavior-build`/`asset-pipeline`/Node builtins. If a measured count
  or graph differs from this text, **58/60 re-measure, record and request bounded
  re-review** — they never widen an exception.

---

## 7. Negative matrix (normative)

### 7.1 Controls and activation

| # | Failure | Expected |
|---|---|---|
| K1 | Start held at the title | start accepted; **0** jump frames; release required before a jump (C1) |
| K2 | Menu press in `playing` | consumed, no command, no jump (C3) |
| K3 | Start/replay while no tick is driven | accepted with `movementSteps: 0` (C4/C5) |
| K4 | Physical press during exclusive test mode | ignored; overlap ⇒ `input_relay_conflict` (C9) |
| K5 | Injected start with no local gesture | sound `blocked`, `unlocked: false`; never `running` (C10) |
| K6 | Hidden tab then resume | input suspended, accumulated time reset, no fast-forward, no stale edge replay (C11) |
| K7 | Gamepad disconnect with a held button | held cleared, keyboard unaffected, no stuck control (C7) |
| K8 | Gamepad API denied / iframe without `allow="gamepad"` | structured unavailable, keyboard play, no second owner (C8) |

### 7.2 Relay, identity and failure

| # | Failure | Expected |
|---|---|---|
| R1 | `expectedRunId` ≠ current | `game_run_stale` (409), **not applied** |
| R2 | unknown/stopped play | `play_not_found` (404) |
| R3 | expired locator | `play_locator_expired` (503) |
| R4 | foreign origin | `bad_origin` (403), no bytes |
| R5 | wrong bridge source/nonce | dropped and counted; `game_relay_rejected` (503), never a fabricated result |
| R6 | no registered browser / WS detached | `session_unavailable` (503) |
| R7 | not yet `presented` | `session_unavailable` (`not_presented`) |
| R8 | no `tl.game.result` in time | `game_relay_timeout` (503) |
| R9 | result over bound | `limits_exceeded` (`result_bytes`) |
| R10 | any message/result/log carrying bytes, token, `contentId` or an eval field | rejected by the strict validators; capability redacted |

### 7.3 Closure, manifest and load

| # | Failure | Expected |
|---|---|---|
| C1 | v2 manifest with a missing `settings`/`game`/`media` block digest | `manifest_invalid` |
| C2 | `media` identity disagreeing with the captured content | `manifest_invalid` (`media_identity`) |
| C3 | asset `kind` mismatch | `asset_kind_mismatch` |
| C4 | late edit/reimport after capture | new `snapshotId`; pinned run/build bytes unchanged |
| C5 | failed/cancelled build | previous output preserved; no partial manifest; no `presented` |
| C6 | stop during artifact load | in-flight reads aborted, disposed, pinned Play unaffected |
| C7 | undeclared or second fetch | closure/graph assertion fails (`export_bundle_graph_forbidden`) |
| C8 | declared artifact missing/digest mismatch | `blob_missing`/`blob_corrupt`; never substituted bytes |
| C9 | WASM compile under the CSP | succeeds only with the §6.1 token; the accepted text fails closed otherwise |

---

## 8. Constants (packet 42 additions)

| Constant | Value |
|---|---|
| `GAME_HOST_API_VERSION` | `1` |
| manifest `manifestVersion` | `2` (M3 captures); `1` remains readable |
| `content.game` canonical cap | 16 384 B (39 §23.10) |
| observation request / result cap | 4 096 B / 16 384 B |
| observation `timeoutMs` | 250–15 000, default 5 000 |
| `events` in one observation | ≤ 32 (`MAX_GAME_EVENTS`, accepted) |
| control actions | `start`, `replay`, `mute`, `unmute` |
| game-control body cap | 4 096 B |
| preview CSP token | `'wasm-unsafe-eval'` added to `script-src` |
| iframe attribute | `allow="gamepad"` |
| artifact MIME classes | §6.3 table |

---

## 9. Fixtures and independent derivation

[`fixtures/m3/delivery/**`](../../../fixtures/m3/delivery/) with `index.json`, a
self-contained plain-Node checker `tools/check-fixtures.mjs` (no new dependency),
a deliberate-corruption negative control (`--corrupt-control`, both controls must
exit non-zero) and an independent digest re-derivation recorded in
`verification.md` (`node:crypto` vs CPython `hashlib` vs `sha256sum`). Contents:

| Fixture | Pins |
|---|---|
| `manifest/manifest-v2-{preimage,example}.json`, `digests/expected.json` | §2 shape, key order, block digests, `buildId` preimage |
| `manifest/v1-v2-rules.json` | §2.1 version decision and what stays v1 |
| `manifest/reproducibility.json` | §2.5 two-tree rule and the M3 additions |
| `settings/pinned-run.json`, `manifest/variants/settings-variant.json` | §3.3 C35-5/B16 and the pinned-run rule |
| `wire/{control,observe}-{request,result}.json`, `wire/relay-cases.json` | §5 shapes, bounds, identity, failure semantics |
| `runs/run-identity.json`, `controls/control-cases.json` | §4, §5.3 |
| `closure/{csp-rows,mime-cache-rows,fetch-graph,scan-rows,export-tree}.json` | §6, §7.3 |
| `deps/dependency-rows.json` | §3.4 |

**Evidence rules (restated).** Canvas evidence is the in-page
`canvas.toDataURL("image/png")` relay and proves the **canvas only**; the title/
HUD/goal require a separate full-page screenshot or a recorded walkthrough, and
the DOM HUD is never inferred from a canvas PNG. Under SwiftShader the
composited page screenshot does **not** carry WebGL content (packet-38 recorded
limitation), so the two evidence kinds are always filed separately. No audio
claim is inferred from an `AudioContext` counter.

---

## 10. Routing table — C39/C40/C41 requests (for packet 43)

One row per request; "not mine" rows name the owner so packet 43 can audit
collisions. Requests are quoted by ID and their destination section.

| Request | Owner (as recorded) | Destination | Disposition here |
|---|---|---|---|
| **C39-1** scene v3 + six components | 39 | project-model §§6/8.1/10/12/17 | not mine (39) |
| **C39-2** §18.1 rule-3 replacement | 41 (supplied) | project-model §18.1 | not mine (41) |
| **C39-3** content key set + `game` | 39 | project-model §18.2 | not mine (39) |
| **C39-4** commands §2 non-goal rewording | 39 | commands §2 | not mine (39) |
| **C39-5** workspace §4.5 threshold `≥3`→`≥4` | 39 | workspace §4.5 | not mine (39) |
| **C39-6** `game_config_invalid`/`game_reference_in_use` | 39 | project-model §23.9 / commands §5.4 | not mine (39) |
| **C39-7** who owns `manifestVersion` + authoring rows | **42** (this packet) | Gate K record | **carried**: §2/§2.1 own `manifestVersion` 1→2; 39's tables add only authoring rows; the packet-38 CSP finding is this packet's (§6.1) |
| **C40-1** runtime §12.4 supersede | 40 | runtime §12.4 | not mine (40) |
| **C40-2** `SimulationPhase` += gameplay/camera | 40 | runtime §12.1 | not mine (40) |
| **C40-3** snapshot `game` field | 40 | runtime §2 | not mine (40; the *manifest* `game` is mine, §2.3) |
| **C40-4** camera pose as camera entity transform | 40 | runtime §6/§12.3 | not mine (40) |
| **C40-5** `PhysicsResetPort` | 40 | runtime §12.6/§13 | not mine (40); the host injects the concrete port, §3.1 |
| **C40-6** `lastCommitted`/boundary hook/effective-frame overrides | 40 | runtime §4/§5/§14.5 | not mine (40) |
| **C40-7** no new settings key | 40 | project-model §21.4/§21.6 | not mine (40); §3.3 resolves the six accepted keys |
| **C40-8** **no** commands §5.4 row | 40 | commands §5.4 | **not mine, confirmed**: run-command failures stay runtime codes; §5.4 records the relay codes as session-layer codes, not command failures |
| **C40-9** `gameCommand`/`GameView`/`setViewport` + carry `content.game` | **42** | sessions/export | **carried**: §3.1 (host surface), §5 (observation), `diffs/sessions.md` S42-3/S42-4/S42-8/S42-10; `manifestVersion` 1→2 is here (§2) |
| **C40-10** `platformer-game` unit rows/edges | **42** | dependencies §3/§4.1/§4.2/§6 | **carried**: §3.4 |
| **C40-11** `GameView.checkpointActive`/`checkpointId` | 41 | presentation | not mine (41); the HUD consumes the bit, §3.1 |
| **C40-12** `GameView.stepIndex` definition review | 40 | runtime §6 | not mine (40); the relay exposes the published value, §5.3 |
| **C41-1** `GameView.playerMotion` | 40 (request) | gameplay §6 | not mine |
| **C41-2** `publishAsset.animation` | 39 | authoring §A3.5/A4 | not mine (39) |
| **C41-3** reimport change/inverse + code/limit rows | 41 | commands §8.5/§5.4 | not mine (41) |
| **C41-4** version-local clip-role exception | 41 | project-model §18.1 | not mine (41) |
| **C41-5** cues carry `assetId` only; no base64/URL; CSP permits Web Audio | **42** | sessions/delivery | **carried**: §5.4 (nothing binary crosses), §6.1 (WASM token only, no `eval`), `diffs/sessions.md` S42-5/S42-9 |
| **C41-6** `game-host` unit row + audio edges; editor UI rule | **42** | dependencies §3/§4 | **carried**: §3.4 |
| **C41-7** `pcm-wav` recipe/metrics/codes | 41 | project-model §§18.5/18.6/18.9 | not mine (41); the recipe version appears in the manifest `recipes` (§2.3) |
| **C41-8** confirm audio captured by digest | 44/58 | project-model §19.2 | not mine; §2.3 requires the audio `kind`+digest row in `assets` |

**Request for other packets (mine → them), for packet 43:**

- **C42-1** packet 48: implement the §5.1–§5.4 wire validators and `tl_game_*`
  tools; §5 is the shape contract, and the PR-2 protocol-scope declaration must
  name these protocol sections.
- **C42-2** packet 55: implement §4/§3.1 in `game-host` + the `input` menu seam.
- **C42-3** packets 58/60: re-measure `export.md` §5.4.1 and the §17.5 fetch list
  on the real bundles and record the result (§3.4, §6.5).
- **C42-4** packet 59: wire the preview wrapper to `createGameHost`, keep the
  `allow="gamepad"` attribute and the §6.1 CSP, and capture canvas vs DOM
  evidence separately.
- **C42-5** packet 43: fold §2 (`manifestVersion` 1→2) and the §3.4 dependency
  rows into the consolidated promotion inventory; the §2.1 identity rule keeps
  `snapshotId`/`buildId`/`outputDigest` distinct.

---

## 11. Compatibility and change rules

- Adding a required manifest key, changing a version rule, changing the CSP
  token set or the `allow` attribute, adding a control action or observation
  field, or relaxing any closure/fetch/scan rule is a **reviewed contract diff**
  (AGENTS.md). Manifest v1 semantics never change.
- The dependency rows, the editor-UI rule and the 58/60 re-measurement
  requirement are part of the PR-5 acceptance: a later packet may not create the
  units without these rows, and may not widen an exception silently.
- `buildId` is never presented as an engine-independent binary hash; `snapshotId`,
  `buildId` and `outputDigest` stay distinct.
- No accepted M1/M2 fixture, trace or evidence label is re-scoped here. Where
  this document and a 39/40/41 proposal disagree, the earlier packet's accepted
  row wins and the disagreement is listed in §10 for packet 43.
