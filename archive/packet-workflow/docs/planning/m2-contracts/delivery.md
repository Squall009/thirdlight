PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# Thirdlight — M2 Delivery, Protocol, Export and Dependency Integration

**PROPOSED — pending Gate E.** This document is a *proposal*: it does not change
any accepted contract. It is packet 19's primary output
(`docs/planning/m2-packets.md` §19); its section-level diffs are
[`diffs/sessions.md`](diffs/sessions.md),
[`diffs/export.md`](diffs/export.md) §"Packet 19 additions",
[`diffs/dependencies.md`](diffs/dependencies.md) §"Packet 19 additions". The
packet-19 additions to packet 15's storage/assets text are recorded as one
promotion-pass change request in [`contract-diffs.md`](contract-diffs.md) §3
(C19-D1) instead of a new diff file. The consolidated proposal ⇒ destination
inventory is [`contract-diffs.md`](contract-diffs.md).
Accepted diffs are applied only in the docs-only promotion step before packet 20;
`docs/contracts/` is binding until then.

Owner pre-approval for this autonomous M2 build:
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final manual
review pending.** This is a pre-approval, not an independent review. Nothing in
this document is approved; Gate E records accept/reject per diff.

Read basis (packet 19 read set): `AGENTS.md`; `docs/STATUS.md` (M2 section);
`docs/planning/m2-packets.md` §19 + the common instructions + "Contract drafting
and promotion" + "Gate review prompt (E–J)"; `docs/planning/m2-plan.md` §§2/3.6/4
(+ the §5 table); `docs/planning/m2-acceptance.md` (A01–A24 + §1);
`docs/contracts/sessions.md` §§2–13; `docs/contracts/export.md` §§3–7;
`docs/contracts/dependencies.md` §§3/4/7/9; `docs/acceptance/m1-report.md` §6
(U-1…U-5); all packet-15/16/17/18 proposals and diffs; the public `exports` maps
and entry surfaces of `packages/{protocol,backend,exporter,runtime,workspace}`.

Precedence rule for this packet: where a packet-15/16/17/18 proposal and this
document disagree, **this document is the later proposal** and the disagreement is
listed in [`contract-diffs.md`](contract-diffs.md) §3. Accepted contracts always
win over both.

---

## 1. Scope, ownership and non-goals

This section defines the **one M2 public boundary**: how an immutable snapshot
becomes (a) bytes the authoring viewport may read, (b) an immutable play artifact
the separate-origin preview may load, (c) an export that runs the same pipeline
with no service dependency. It fixes routes, messages, error mappings, numeric
bounds, per-package exports/edges/pins and the negative-test matrix. It
implements nothing (packets 25/33/35/36 implement).

| Unit | Owns here | Must not |
|---|---|---|
| `workspace` | immutable blob reads, staging, snapshot capture, the capture-at-one-revision guarantee (`content-storage.md` §8), `captureContentView` | expose a path-addressed read; serve transport |
| `project-model` | the captured content view, the manifest document's *logical* half (scene + resolved asset/version records), canonical serialization | know about locators, routes or time |
| `protocol` | every route/message/error shape added here (one parser, one truth) | duplicate a schema in `backend`/`editor`/`mcp-adapter` |
| `backend` | framing/handling the routes below, coordinating bounded jobs, serving immutable play artifacts through the locator, the input-relay routing | implement storage; bypass `runCommand`; hold a lock across I/O |
| `exporter` | the shared build orchestration, output closure, `meta.json` | a second runtime/controller/compiler implementation |
| `asset-pipeline` | pure GLB inspection (packet 24) | I/O, locators, serving |
| `behavior-build` | the shared `compileBehavior` + artifact-manifest builder (packet 33) | serve; evaluate source; a second compiler |
| `editor` | the authoring viewport's authenticated reads, the preview host and bridge | renderer credentials; a second mutation path |

Non-goals in this document: a general CDN or public hosting, a multi-tenant
capability service, cross-project content sharing, service workers, offline
caching policy, resumable ranged downloads, WebRTC/streaming delivery, a browser
automation environment (U-5), and any headless substitute for the owner browser
(sessions.md §10.4 stays normative: no browser ⇒ structured unavailable).

## 2. The immutable runtime-content manifest

A play or export build consumes exactly one **runtime-content manifest**: the
complete, frozen description of what will run. It is captured from **one
authoring revision** and never re-read afterwards.

### 2.1 Manifest document (strict)

```json
{
  "manifestVersion": 1,
  "type": "thirdlight-runtime-content",
  "projectId": "demo-0001",
  "revision": 12,
  "snapshotId": "demo-0001@r12",
  "capturedAt": "2026-09-18T10:00:00Z",
  "sceneDigest": "<64 lowercase hex>",
  "contentDigest": "<64 lowercase hex>",
  "assets": [
    { "assetId": "asset-0001", "version": 2, "sourceDigest": "<64 hex>",
      "sourceByteLength": 4096, "recipeDigest": "<64 hex>",
      "metricsDigest": "<64 hex>", "path": "content/sha256/<64 hex>" }
  ],
  "behaviors": [
    { "behaviorId": "behavior-0001", "sourceDigest": "<64 hex>",
      "sourceByteLength": 1234, "manifestDigest": "<64 hex>",
      "outputDigest": "<64 hex>", "outputByteLength": 4096, "apiVersion": 1,
      "path": "behaviors/<64 hex>.js" }
  ],
  "modules": [
    { "id": "thirdlight.platformer:controller", "apiVersion": 1,
      "package": "@thirdlight/platformer", "version": "0.2.0" }
  ],
  "enginePins": [
    { "id": "@thirdlight/runtime", "version": "0.2.0", "apiVersion": 1 },
    { "id": "@thirdlight/three", "version": "0.186.0", "apiVersion": 0 }
  ],
  "recipes": { "gltf-glb": 1, "behavior-source": 1 },
  "toolchain": {
    "esbuild": "0.28.2", "typescript": "5.9.3",
    "optionsDigest": "<64 hex>"
  },
  "buildOptionsDigest": "<64 hex>",
  "buildId": "<64 hex>"
}
```

Fields (all required; unknown fields ⇒ invalid; canonical key order as written,
2-space indent, LF, one trailing newline, no BOM):

| Field | Rule |
|---|---|
| `manifestVersion` | exactly `1` (M2). A new required field or a meaning change ⇒ `2`. |
| `type` | exactly `"thirdlight-runtime-content"` (discriminator; no auto-detection). |
| `projectId` / `revision` / `snapshotId` | from the captured snapshot; `snapshotId` must equal `<projectId>@r<revision>` (runtime.md §2). |
| `capturedAt` | UTC second at capture (project-model §7.2 format). Not a digest input. |
| `sceneDigest` | SHA-256 of the canonical scene document bytes at that revision (project-model §12.2). |
| `contentDigest` | SHA-256 of the canonical **captured content view** (`assets.md` §9.2; recomputable, `fixtures/m2/contracts/catalog/captured-content-view.json`). |
| `assets` | every asset version reachable from the captured scene/prefabs, ascending by `assetId` then `version`; `version` is the **resolved immutable version** (an `assetId` reference resolves to exactly one version here). |
| `behaviors` | every published behavior with a non-null `source` reachable from the captured scene, ascending by `behaviorId`. Declaration-only behaviors are omitted (they link nothing). |
| `modules` | the **required engine modules** for this snapshot's module set, ascending by `id`; `thirdlight.demo:box-motion` when selected. |
| `enginePins` | the pinned engine package versions + `apiVersion`s the bundle was built against (ascending by `id`), copied verbatim from the pinned module table (`behaviors.md` §5.3). |
| `recipes` | the recipe/profile versions used to derive every `recipeDigest`/`outputDigest`. |
| `toolchain` | the exact build tool versions and `optionsDigest` (the record of the pinned option set, §4.2). |
| `buildOptionsDigest` | SHA-256 of the canonical option-set record. |
| `buildId` | SHA-256 (lowercase hex) of the canonical **document serialization** of this manifest without the `buildId` key: `JSON.stringify(manifestWithoutBuildId, null, 2) + "\n"` (UTF-8), key order exactly as in §2.1 with `buildId` last. The manifest is self-identifying. |

### 2.2 Snapshot identity vs build identity (normative)

- **The manifest is captured at exactly one authoring revision.** `snapshotId`
  identifies the input: an asset reimport, a source publication or a settings
  edit after capture produces a *different* `snapshotId`. `manifestVersion`-level
  input identity is `<projectId>@r<revision>`, nothing more.
- **`buildId` is derived and is NOT an engine-independent binary hash.** It
  identifies the manifest + engine pins + toolchain versions + option set. Two
  projects at the same `revision` can produce different `buildId`s; the same
  `snapshotId` can produce a different `buildId` after an engine/toolchain/option
  change. The contract **never equates `project@revision` with a binary hash**,
  and no UI, log or `meta.json` field may present them as interchangeable.
- **The output closure digest** (export, §9) is a separate, later value: it is the
  SHA-256 record of the emitted tree and is reported as `outputDigest` in
  `meta.json`, alongside (not instead of) `snapshotId`/`buildId`.
- **Staleness rule.** A play/export build is stale iff the captured
  `snapshotId` no longer matches the revision it was captured from **or** any
  resolved asset/behavior/output digest differs from the manifest. A stale build
  is never served as current: the locator (§6) resolves the captured content, the
  requestor is told it is stale, and a fresh play/export captures a new manifest.
- **Build failure preserves the previous output** (`behaviors.md` §8.7 table
  row B, applied to the derived bundle): the previous immutable artifact and its
  locator remain served and exportable; the failed build writes no output, and
  the publication that triggered it stands (record, revision, blobs unchanged).

## 3. Atomic snapshot capture

1. The backend resolves the project through the workspace (read-only), loads the
   current revision and reads `scene` + `content` from **one** acknowledged
   envelope state.
2. It derives `sceneDigest` and `contentDigest` from the canonical bytes, then
   builds the manifest of §2.1 from that single read.
3. It re-reads the revision (workspace re-read) and compares; a change ⇒
   `export_snapshot_mismatch` (export) / the play-start equivalent
   (`revision_conflict` with `currentRevision`) — never a mixed capture.
4. The capture is a pure derivation (`captureContentView` + `captureManifest`);
   it takes no mutation lock, writes nothing authoritative and creates no
   revision.
5. Only **completed** artifacts are addressable: the manifest is published at the
   same moment as the artifact set it names, and the locator points at the
   artifact set, never at a work-in-progress directory.

Numeric bounds: the manifest document ≤ 262 144 B (2 × `content_bytes` headroom
for the resolved copies; enforced at capture); a manifest that exceeds it is
`limits_exceeded` (`manifest_bytes`) and no artifact is produced.

## 4. Build identity, engine fetches and the scan policy

### 4.1 Build pipeline (one pipeline, two consumers)

Play and export consume the **same** pipeline: the same `runtime`, `three-adapter`
and packet-17/18 engine modules at the same pins, the same linked behavior
outputs, and the same output closure builder. There is no separate gameplay
implementation (export.md §5.1; `behaviors.md` §8.7).

### 4.2 Option-set record

The pinned option set of export.md §5.3 remains binding for the **final** bundle
(`bundle: true, platform: "browser", format: "iife", treeShaking: false,
sourcemap: false, minify: false`, esbuild 0.28.2). The option-set record (`buildOptionsDigest` = SHA-256 of its canonical document
serialization, `JSON.stringify(record, null, 2) + "\n"`, UTF-8, key order as
written):

```json
{ "bundler": "esbuild@0.28.2", "bundle": true, "platform": "browser",
  "format": "iife", "treeShaking": false, "sourcemap": false, "minify": false,
  "target": "es2022", "loaders": ["ts", "tsx"] }
```

The behavior-compiler intermediate keeps its own closed option set
(`behaviors.md` §5.4, `format: "esm"`); it is **not** a §5.3 bundle
(`diffs/export.md` E18-5) and its `outputDigest` is recorded in the manifest.

### 4.3 Engine-fetch policy (replaces M1's one-fetch rule, by explicit diff)

M1 pinned **exactly one engine-initiated `fetch`** (`./snapshot.json`) and no
preview content fetch. M2 replaces that rule **only through this contract diff**;
it does not weaken the scan.

| Bundle | Permitted engine-initiated fetches (exhaustive) |
|---|---|
| play-preview bundle | `./manifest.json`, `./game.js`-relative behavior outputs, and one read per unique declared asset path of the manifest — every path **relative to the artifact root**, each requested **once per unique path**, all same-origin with the artifact root |
| export bundle | the same set, relative to the export output tree (`./manifest.json`, `./content/sha256/<digest>`, `./behaviors/<digest>.js`) |

Normative rules:

1. Every fetch target must be a **declared path of the served manifest** for the
   resolved `contentId`/output tree. A fetch of an undeclared path is a contract
   violation (a build finding, not a runtime fallback).
2. No absolute URL, no cross-origin request, no CDN, no `data:` script, no
   `file://`, no `http(s)://` literal (§5/§6 below). The fetch count is
   `1 + |unique declared artifacts|` and is asserted per bundle in the negative
   matrix (§10.2).
3. The `behaviors.md` §5.5 output scan and export.md §5.4/§5.4.1 scans still run
   over the emitted bytes; the §5.4.1 recorded-exception table is unchanged and
   remains bound to `three@0.186.0` + the §5.3 option set.
4. A manifest that declares zero behaviors and zero assets (M1-style scene)
   reduces to the M1 case: `./manifest.json` replaces `./snapshot.json` as the
   single engine fetch (recorded as the compatibility rule in §12 below).

### 4.4 Format-aware resource validation (normative)

M1's textual pattern scan was written for JavaScript bundles. Running it over a
GLB or a WASM binary is meaningless (patterns can appear inside compressed/binary
payloads by chance, and real forbidden content can hide in structures a text scan
cannot see). M2 therefore validates **by container format**, then scans text:

| Container | Validator | Must reject |
|---|---|---|
| JS/text bundle | `scanTextBundle(bytes)` — the export.md §5.4 a–j patterns + §5.4.1 counts | absolute/remote locators, credentials, `node:`, `__dirname`/`process.`, `/api/v1/`, `/mcp`, `XMLHttpRequest`/`WebSocket` |
| GLB (asset bytes) | `scanGlbContainer(bytes)` — glTF magic/version/declared length, chunk table, JSON-chunk strict parse, **every `uri` value**: no value may contain `://`, `data:`, `file:`, `//`, a leading `/`, `..`, or a backslash; `buffer.uri` absent (embedded) or a `data:`-free relative name that exists in the container's own blob map | remote/external/absolute URIs, undeclared external buffers, non-GLB file magic |
| WASM (if separately emitted) | `scanWasmContainer(bytes)` — `\0asm` magic + version 1, declared SHA-256 pin match, MIME record `application/wasm`, imports ⊆ the approved host-import allowlist (`[]` for M2) | magic/version mismatch, digest mismatch, any host import, `fetch`-style custom section is not a thing but any declared `http(s)://` name section value is rejected |
| Output tree | `assertRelativeClosure(tree)` — every file is under the output root; every reference in every emitted file is relative (`./…`); no absolute path, no `file://`, no `http(s)://` | any absolute/remote reference or escape |

Numeric assertions: each declared asset path is read exactly once; the total
fetched byte count equals the sum of declared `sourceByteLength`/`outputByteLength`
(±0); no request leaves the artifact origin. The **browser** network panel is the
acceptance-level check (A18/A21/A22); the byte-level checks above are the
build-time checks.

## 5. Authoring content reads (authenticated, immutable version)

The authoring viewport obtains **committed GLB bytes** through one route. This
route is **not** the preview delivery path and can never expose staged or
arbitrary project files.

**Route.** `GET /api/v1/projects/:projectId/content/assets/:assetId/versions/:version/bytes`

| Aspect | Rule |
|---|---|
| Origin | the authoring origin only (`sessions.md` §4.2 allowlist); any other Origin ⇒ `bad_origin` (HTTP 403, the accepted §4.2 status) |
| Auth | the project's authoring bearer token or admin scope (sessions.md §4.1); missing/invalid/expired ⇒ `unauthorized` (401) |
| Addressing | `assetId` and `version` are identifiers, never paths; `version` is a positive integer; both are validated before any storage call (`field_value` on failure). No path segment may contain `/`, `\`, `%2e`, `%2f` or `..` — decoded and rejected ⇒ `path_rejected` (400, before any read) |
| Resolution | the workspace resolves `(assetId, version) → sourceDigest` from the last acknowledged catalog; a version the catalog does not contain ⇒ `asset_not_found` / `asset_version_not_found` (404) |
| Integrity | the workspace re-verifies the digest before returning bytes (`content-storage.md` §8.1); mismatch ⇒ `blob_corrupt` (500), missing ⇒ `blob_missing` (503); bytes are never substituted or degraded |
| Response | `200`, `Content-Type: application/octet-stream`, `Content-Length: <byteLength>`, `X-Thirdlight-Digest: <sourceDigest>`, `ETag: "<sourceDigest>"`, `Cache-Control: private, max-age=31536000, immutable` |
| Bound | ≤ 33 554 432 B (the source-blob cap); a larger declared version is `limits_exceeded` and is never streamed |
| Never | staged bytes (`stageId` is not addressable here), a path read, another project's blob, a directory listing, a range request that bypasses digest verification, or a second version of an `assetId` under a different `assetId` |

**Renderer receives no authoring token.** The editor fetches the bytes (or hands a
resolver closure that performs the authenticated fetch) and passes **bytes or a
resolver** into `three-adapter`'s realization helpers. The adapter, its resources
and any injected loader never see a token, a URL or `fetch`. `three-adapter`
gains no network edge (dependencies.md §4.3 is unchanged; the fetch lives in
`editor`'s authoring transport layer, which already talks HTTP to the backend).

## 6. Preview delivery: the immutable play-content locator

The preview frame receives **only** completed immutable artifacts. It receives
**no authoring token**, **no** general project filesystem endpoint and **no**
`/api/v1` route.

### 6.1 Shape

`POST /api/v1/projects/:projectId/play` (unchanged shape plus one field) returns:

```json
{ "ok": true, "playSessionId": "play-…", "playBase": "http://127.0.0.1:8502/",
  "snapshotId": "demo-0001@r12", "revision": 12, "demo": true, "expiresAt": "…",
  "playContent": { "contentId": "<43-char base64url>", "buildId": "<64 hex>",
                   "path": "/play-content/<contentId>/", "expiresAt": "…",
                   "manifestPath": "manifest.json" } }
```

- `contentId` = 32 cryptographically random bytes, base64url without padding
  (`^[A-Za-z0-9_-]{43}$`). It is the **bearer capability** for one immutable,
  project-scoped artifact set captured from one `snapshotId`/`buildId`.
- `path` is relative to the preview origin. The editor builds the iframe `src` as
  `<playBase><path without leading slash>?play=<playSessionId>&content=<contentId>`
  (both identifiers; the preview reads them from its own URL, never from a bridge
  message).
- The artifact set is served by `backend` from the completed artifact store —
  never from a project directory, never from a temp directory.

### 6.2 Locator routes (preview origin, no credentials)

| Route | Purpose |
|---|---|
| `GET /play/:playSessionId?content=<contentId>` | the preview shell (the only dynamic page); validates the live `playSessionId`↔`contentId` pairing |
| `GET /play-content/<contentId>/manifest.json` | the §2 manifest |
| `GET /play-content/<contentId>/game.js` | the built entry bundle |
| `GET /play-content/<contentId>/content/<assetId>/<version>` | one immutable committed asset version (same digest/`ETag`/`Cache-Control` rules as §5, re-verified) |
| `GET /play-content/<contentId>/behaviors/<outputDigest>.js` | one immutable compiled behavior output |

Success `200`; the response for every artifact carries its declared digest and
byte length. Failure mapping (all before any bytes are served):

| Condition | Code | HTTP | cls |
|---|---|---|---|
| malformed `contentId` / `playSessionId` / unpaired | `play_locator_invalid` | 404 | `not_found` |
| expired locator (§6.4) | `play_locator_expired` | 503 | `unavailable` |
| artifact set not yet complete (build in flight) | `play_content_not_ready` | 409 | `conflict` |
| no successful build for the requested `buildId` | `play_build_unavailable` | 503 | `unavailable` |
| traversal / listing / undeclared path / cross-project path | `path_rejected` | 400 | `validation` |
| declared artifact missing or digest mismatch | `blob_missing` / `blob_corrupt` | 503 / 500 | `unavailable` / `internal` |

`play_locator_expired` is `cls: "unavailable"` because sessions.md §11.2's status
mapping is normative and has no "gone" class; the distinct code, not the status,
is what a client must branch on. `expiresAt` is carried for truthful UI.

### 6.3 Authorization, leakage and capability handling (normative)

- **Single-purpose:** the locator authorizes **reads of one immutable artifact
  set only**. It cannot start/stop plays, read authoring state, run commands, list
  assets, list locators, or reach another project's artifacts.
- **No listing, no traversal, no enumeration:** only the exact routes above
  resolve. Directory listing is disabled; any other path (including
  `/play-content/<contentId>/` and `/play-content/`) is `path_rejected`; a request
  for a path under a different `contentId` is `path_rejected` (never a
  cross-project read).
- **Redaction:** `contentId` (and the `?content=` value) is a secret-equivalent.
  It is replaced by `<redacted:contentId>` in every session log entry, error
  `message`/`hint`, diagnostics relay and telemetry. The bounded log rule of
  sessions.md §11.1 already forbids absolute paths; this adds locator redaction as
  a normative rule. `contentId` values are **excluded from exports** (export.md
  §5.4 pattern set gains a locator-value check; §9 below).
- **Origin and framing:** the locator routes are served from the preview origin
  (§2 of sessions.md) with `X-Frame-Options`/`frame-ancestors` restricted to the
  exact authoring origin, `Referrer-Policy: no-referrer`, and
  `Cross-Origin-Resource-Policy: same-origin`.
- **CSP (preview origin, artifact responses and shell):**

  ```text
  default-src 'none'; script-src 'self'; connect-src 'self';
  img-src 'self' data:; style-src 'self'; font-src 'none'; worker-src 'none';
  object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors <exact authoringOrigin>
  ```

- **Cache behavior:** artifact responses are `Cache-Control: private, immutable`
  with a `max-age` equal to the remaining locator lifetime (never longer), plus
  `ETag: "<digest>"`. A reload of the same `contentId` therefore resolves to the
  **same bytes** for the life of the capability: a reconnect, reload or repeated
  fetch must never resolve to newer bytes. A fresh play allocates a new
  `contentId`.
- **No authoring credentials:** the preview page config and bundles contain no
  token, no `/api/v1` URL and no authoring-service call (sessions.md §13.2;
  package scans in §10.2). The only content capability is the read-only locator.
- **Cleanup:** on play termination (stop, `preview_failed`, `preview_timeout`,
  `expired`, `session_lost`) the backend marks the artifact set unreachable after
  a **60 s grace** (for in-flight reads) and removes the contentId↔playSessionId
  pairing. The artifact bytes themselves are immutable and retained outside the
  locator (they may already be pinned by another play/export); removing the
  capability never removes authoritative or derived content that another
  snapshot pins, and a locator is never reused for a different artifact set.

### 6.4 Locator lifetime

| Constant | Value | Rule |
|---|---|---|
| `PLAY_CONTENT_TTL` | 900 s (15 min) | absolute from play start; never extended by reads |
| `PLAY_CONTENT_GRACE` | 60 s | after a terminal play state, in-flight reads may complete |
| `PLAY_CONTENT_ID_BYTES` | 32 | → 43-char base64url `contentId` |
| max artifact set | 536 870 912 B (512 MiB) | the §2 manifest closure; larger ⇒ `play_build_unavailable` (`reason: "closure_bytes"`) |
| max single artifact | 33 554 432 B (32 MiB) | per asset/behavior path |

A locator whose TTL elapsed is `play_locator_expired` for every route, including
a reload of an already-presented preview; the editor must start a new play.

## 7. Versioned bridge (v2)

The M1 bridge is versioned in place: `window.__thirdlightPreview.v` becomes `2`.
The exact-origin/source/nonce checks of sessions.md §13.3–§13.4 are **unchanged**
and remain mandatory; v2 adds messages and payload rules.

**Preview page config (sessions.md §13.2, v2):**

```js
window.__thirdlightPreview = {
  v: 2,
  authoringOrigin: "<O_A exact>",
  playSessionId: "<from ?play=>",
  contentId: "<from ?content=>",
  manifestPath: "./manifest.json"
};
```

Still **no tokens, no API URLs, no credentials**. `contentId` is a capability, so
it is treated as sensitive in logs (redaction, §6.3) but is not an authoring
credential.

**New/changed messages (added to the sessions.md §13.5 allowlist):**

Editor → preview: `tl.handshake` gains `bridgeVersion: 2, contentId, buildId`;
new `tl.playContent.expect` (`v, playSessionId, contentId, buildId`) sent once
after a successful handshake; new `tl.input.request`
(`v, playSessionId, requestId, frames[]`).

Preview → editor: `tl.ready` gains `buildId, contentDigest, stepIndex`;
`tl.error` gains `phase`; new `tl.load.progress`
(`v, playSessionId, phase, loadedBytes, totalBytes`) with `phase ∈
{"shell","manifest","assets","behaviors","runtime"}`; new `tl.input.result`
(`v, playSessionId, requestId, ok, appliedFromStep?, appliedToStep?, error?`).

**Payload bounds:** every v2 message ≤ 65 536 B except `tl.snapshot` (≤ 1 048 576 B,
unchanged) and `tl.screenshot.result` (≤ 1 572 864 B, unchanged); `tl.load.progress`
≤ 1 024 B; `frames[]` in `tl.input.request` ≤ 600 entries and ≤ 16 384 B.
**No GLB bytes and no compiled behavior source/bytes appear in any bridge message
or WS full-state frame** — the preview loads bytes itself from the locator.
`mutation.applied`/full-state frames are unchanged and carry no binary content
(sessions.md §11.6 bound restated).

**Readiness:** the preview posts `tl.ready` only after (1) the manifest is loaded
and its `buildId` matches `tl.playContent.expect`, (2) every declared asset read
completed and verified, (3) the physics port initialized, and (4) the behavior
outputs are linked and the runtime instantiated. A failed/cancelled load posts
`tl.error` with the phase; the editor reports a truthful failure and never
`presented`. A mismatch of `buildId`/`contentDigest` ⇒ `tl.error` (`phase:
"manifest"`, code `play_content_not_ready`), never a silent retry against newer
bytes.

## 8. Bounded input-exercise relay (MCP)

### 8.1 Route and shape

`POST /api/v1/projects/:projectId/play/:playSessionId/input`

```json
{ "mode": "exclusive-test",
  "frames": [ { "stepOffset": 0, "moveX": 1, "jump": "pressed" },
              { "stepOffset": 1, "moveX": 1, "jump": "held" } ] }
```

- `mode` is exactly `"exclusive-test"`; any other value ⇒ `field_value`. There is
  no per-frame time field: the relay is **step-indexed** (the same `ActionFrame`
  shape and validation as the recorded source, `input.md` §2/§6).
- `frames` is 1–`maxRelaySteps` (600) entries, ascending by `stepOffset`, no
  duplicates, `stepOffset` gaps allowed. Body ≤ 16 384 B.
- Semantic actions only: this is **not** DOM event injection, `eval`, synthetic
  `KeyboardEvent`/`GamepadEvent` dispatch or a second mapping implementation.

### 8.2 Result

```json
{ "ok": true, "mode": "exclusive-test", "playSessionId": "play-…",
  "snapshotId": "demo-0001@r12", "buildId": "<64 hex>",
  "appliedFromStep": 1481, "appliedToStep": 1531,
  "inputMode": "test", "clearedAt": "2026-09-18T10:00:01Z" }
```

- It reports the **applied step range** and the `snapshotId`/`buildId` the frames
  ran against; a caller can therefore distinguish stale observations.
- The mode is **exclusive**: while it is active the browser binding's sampled
  frames are ignored (physical and injected input must not race), and the bridge
  applies the injected sequence strictly in `stepOffset` order. On completion, on
  stop, on preview disconnect and on locator expiry the mode is cleared and the
  physical source is re-armed from a neutral frame; a subsequent physical press is
  a fresh edge. There is no partial clear.
- Failure mapping: no registered browser / owner WS detached ⇒ `session_unavailable`
  (503, the existing structured no-browser outcome — never a simulated success);
  unknown/stopped play ⇒ `play_not_found` (404); a relay with physical input
  already engaged since the last neutral step ⇒ `input_relay_conflict` (409);
  `frames` over a bound ⇒ `input_relay_limits_exceeded` (400); no
  `tl.input.result` within 10 s ⇒ `input_relay_timeout` (503).
- The relay never mutates authoring state, never writes the envelope and never
  becomes a second command path.

## 9. Export closure and metadata

- **Complete reachable closure.** The export emits the §2 manifest and every
  artifact it declares: all reachable GLB asset versions, all reachable behavior
  outputs, the built `game.js`/entry, and the pinned engine modules. "Reachable"
  is transitive over the captured scene → prefabs → behavior source records →
  their `requiredModules`. All paths are **relative to the output tree**
  (`./manifest.json`, `./content/sha256/<digest>`, `./behaviors/<digest>.js`,
  `./js/main.js`).
- **No service dependency.** The output requires no backend, MCP or model service;
  it makes no CDN/absolute/remote fetch (the §4.3 relative-artifact rule). The
  backend being stopped/unreachable changes nothing (A21).
- **No credentials, capability URLs, host paths or locator values** anywhere in
  the output bytes. The §5.4 scan patterns a–j apply, extended by a locator-value
  pattern (the exporter is given the active `contentId`s to scan for, exactly as it
  is given token values today) and by the format-aware validation of §4.4 for
  GLB/WASM artifacts.
- **Metadata.** `meta.json` (export.md §6) gains `manifest` (schemaVersion, the
  §2 manifest digest fields: `snapshotId`, `revision`, `buildId`,
  `buildOptionsDigest`, `contentDigest`), `licenses` (one entry per bundled
  dependency/artifact: `{ id, version, license, source }`), `artifacts` (count +
  total bytes per class) and `outputDigest`. Exact versions and SHA-256 hashes of
  every bundled artifact belong in the metadata; the previous fixed `three`/
  `typescript`/`esbuild` fields remain.
- **Failure preserves the previous output** (export.md §3 replacement semantics
  unchanged): build/scan/closure failure removes only the temp tree.

## 10. Negative-test matrix (normative)

### 10.1 Protocol and authorization

| # | Attack / failure | Expected outcome |
|---|---|---|
| N1 | asset-bytes route called with another project's token / no token | `unauthorized` (401); no bytes, no path disclosure |
| N2 | asset-bytes route from a foreign Origin | `bad_origin` (403) with the clipped `found` Origin |
| N3 | asset version from a different project | `asset_not_found`/`asset_version_not_found` (404) — never a cross-project read |
| N4 | `assetId`/`version` containing `/`, `..`, `%2e%2e`, `%2f`, `\` | `path_rejected`/`field_value` **before** any storage call |
| N5 | staged-only bytes requested through the asset route | `stage_not_found`/`asset_version_not_found`; staged bytes are unrepresentable in the route |
| N6 | tampered committed blob | `blob_corrupt` (500); bytes retained; every read re-verifies |
| N7 | locator route with a valid `contentId` but a stopped/absent play session | `play_locator_invalid` (404) |
| N8 | locator path traversal / listing / undeclared artifact / other `contentId` | `path_rejected` (400); no listing |
| N9 | expired locator (TTL) incl. preview reload | `play_locator_expired` (503), `expiresAt` present |
| N10 | reload during the TTL | identical bytes + `ETag`; never newer content |
| N11 | locator value present in a log/error message | redacted to `<redacted:contentId>`; `message` ≤ 256 |
| N12 | malformed binary upload (bad offset, wrong total, mid-frame disconnect) | `content_frame_invalid`/`stage_limits_exceeded`; no stage file extension, no publication |
| N13 | upload declared length > frame cap / stage cap | `stage_limits_exceeded` (`frame_bytes`/`stage_bytes`) before writing |
| N14 | input relay against no browser | `session_unavailable` (503) — structured, never success |
| N15 | input relay concurrent with physical input | `input_relay_conflict` (409); no frames applied |
| N16 | input relay frames > 600 / body > 16 KiB / non-ascending offsets | `input_relay_limits_exceeded` / `field_value` |
| N17 | relay step range reported against a newer play | result carries the original `snapshotId`/`buildId`; caller sees the staleness |
| N18 | WS full-state frame or `mutation.applied` carrying GLB/compiled-script bytes | rejected by the strict protocol validators (binary content is unrepresentable) |

### 10.2 Bundle and export scans (format-aware)

| # | Probe | Expected |
|---|---|---|
| S1 | text bundle with `http://`/`/api/v1/`/token value | `export_bundle_forbidden_content` / preview build fails |
| S2 | GLB whose JSON chunk carries `uri: "https://…"` | `import_rejected` → `asset_uri_rejected` (packet 24), never an export-time fetch |
| S3 | GLB with an external buffer path (`uri: "buf.bin"`) | rejected (embedded-only profile) |
| S4 | WASM with a wrong digest / host import | `scan_forbidden_content` / refusal, no output |
| S5 | export bundle fetches an undeclared path or a second copy of one declared path | build-time closure/fetch-count assertion fails; browser network panel shows only declared relative reads |
| S6 | export bundle contains a locator value or an authoring token | `export_bundle_forbidden_content` |
| S7 | runtime bundle includes `backend`/`workspace`/`commands`/`mcp-adapter`/`behavior-build` | `export_bundle_graph_forbidden` / boundary check fails |

## 11. Constants (normative, packet 19)

| Constant | Value |
|---|---|
| `PLAY_CONTENT_TTL` / `PLAY_CONTENT_GRACE` | 900 s / 60 s |
| `PLAY_CONTENT_ID_BYTES` | 32 (43-char base64url) |
| play artifact set / single artifact cap | 536 870 912 B / 33 554 432 B |
| asset byte read response cap | 33 554 432 B |
| asset byte read cache | `private, max-age=31536000, immutable` + `ETag` digest |
| upload frame cap / stage cap | 1 048 576 B / 33 554 432 B (packet 15 bounds reused) |
| stage TTL / open stages / staged bytes per project | 3 600 s / 8 / 134 217 728 B |
| inspection job timeout / publish job timeout / build timeout | 30 s / 120 s / 120 s |
| manifest document cap | 262 144 B |
| input relay: max frames / max body / ack timeout | 600 / 16 384 B / 10 s |
| bridge message cap (v2 non-snapshot) / `tl.load.progress` cap | 65 536 B / 1 024 B |
| WS full-state frame cap / `mutation.applied` cap | unchanged (1 MiB / in-frame bound) |
| behavior compiler bounds (unchanged, packet 18) | `COMPILER_LIMITS` (`behaviors.md` §6) |
| physics constants (unchanged, packet 17) | `CONTROLLER_CONSTANTS` / `physics.md` §7 |
| snapping (sessions.md §9 diff) | translate 0.25 m, rotate 15°, scale 0.25, scales ∈ [0.01, 100] |

## 12. Compatibility with M1 (explicit)

- **Single-fetch rule.** For a snapshot whose manifest declares zero assets and
  zero source-bearing behaviors, the engine-initiated fetch set reduces to
  `./manifest.json` (replacing M1's `./snapshot.json`). This is a **recorded
  contract diff** to export.md §5.3/§5.4.1, not a scan exemption: the §5.4.1
  exception counts for three are unchanged, and pattern d's exact-count rule is
  restated as "the declared-artifact set + the one manifest fetch".
- **Versioned export layout.** The M1 layout (`index.html`, `js/main.js`,
  `snapshot.json`, `meta.json`) is superseded by `index.html`, `js/main.js`,
  `manifest.json`, `meta.json`, `content/**`, `behaviors/**` for M2 exports;
  M1-only readers (the M1 export page) remain compatible because an M1 export is
  unchanged and a new export declares `meta.json.schemaVersion 2` (§9).
- **Existing play sessions.** M1's `play.started`/`tl.snapshot` path is replaced
  by the v2 locator+bridge only after packet 35; until then the accepted M1
  behavior is unchanged and the new routes are unavailable (not half-implemented).
- **No update of accepted M1 text** except through the diffs listed in
  [`contract-diffs.md`](contract-diffs.md).

## 13. U-4 disposition (owner pre-approval required at Gate E)

Recorded with the owner pre-approval tag; **final manual review pending**. Both
M1 contract-change requests (U-4; Gate C CF-2/CF-3 are the same two items) are
**ACCEPTED as proposed**, exactly as implemented fail-closed:

1. **`engineRoot` (sessions.md §13.7) — ACCEPT.** Add the optional backend config
   field + `THIRDLIGHT_ENGINE_ROOT` env var. Exact diff:
   [`diffs/sessions.md`](diffs/sessions.md) S19-11. Additive/optional;
   absent ⇒ the export route fails closed with a structured `unavailable` result;
   no other route is affected.
2. **export.md §5.4.1 reference-entry interpretation under pinned esbuild —
   ACCEPT.** The binding record (table counts) is unchanged; the *entry* that
   materializes the reference full-core bundle is
   `import * as THREE from 'three'; console.log(THREE.REVISION);`. Exact diff:
   [`diffs/export.md`](diffs/export.md) E19-8. Without this clause binding 3 is
   unsatisfiable under the pinned `treeShaking: false` behavior (an unused
   namespace import elides to an empty IIFE).

If the owner rejects either at Gate E, the affected implementation stays
fail-closed and a bounded follow-up is recorded; nothing else depends on them.

## 14. Public surface summary (proposed)

**Routes** — §5 (asset bytes), §6.1/§6.2 (play content), §8.1 (input relay),
plus packet-25 content/job/query routes (`content-storage.md` §13.1; job and
query routes in §15 below).

**Messages** — §7 bridge v2 list; `protocol` remains the sole wire-shape package
(no duplicate schema anywhere).

**Packages/exports/edges/pins** — [`diffs/dependencies.md`](diffs/dependencies.md)
§"Packet 19 additions": units `asset-pipeline`, `input`, `physics-rapier`,
`platformer`, `behavior-build`; the `runtime` behavior/port types; the Rapier pin
`@dimforge/rapier2d-compat@0.20.0` (selection per decision 0002 §1).

## 15. Content, job and query service surface (packet 25 shape)

Bounded, project-scoped, authoring-origin only; all results are strict JSON with
the §11.2 error shape. `limit` defaults/limits: assets 1–200 (default 50),
versions per asset ≤ 32, jobs 1–50 (default 20), integrity entries ≤ 1 024.

| Route | Result |
|---|---|
| `POST …/content/stages` | `{ ok, stageId, expiresAt }` |
| `PUT …/content/stages/:stageId/bytes` | `{ ok, stageId, byteLength, digest, complete }` (raw body ≤ 1 MiB/frame, `X-Thirdlight-Offset`) |
| `POST …/content/stages/:stageId/inspect` | `{ ok, proposal, truncated }` (proposal ≤ 256 KiB) |
| `DELETE …/content/stages/:stageId` | `{ ok, discarded }` |
| `GET …/content/assets` | `{ ok, assets, nextCursor }` (bounded summaries; no bytes, no recipe internals) |
| `GET …/content/assets/:assetId` | `{ ok, asset, versions }` |
| `GET …/content/integrity` | `{ ok, entries, summary }` |
| `GET …/content/jobs/:jobId` | `{ ok, job }` (`job_not_found` 404; expired/late ⇒ `job_expired` 503) |
| `GET …/queries` | the accepted query surface plus the packet-16 content/prefab/behavior queries |

Every write still goes through `POST …/commands` → `workspace.runCommand` (the
sole executor). The upload route only prepares; inspect only proposes; the command
commits (dedup precedes stage lookup, `content-storage.md` §6.1).

## 16. Fixture index (packet 19 additions)

`fixtures/m2/contracts/delivery/**`, indexed by `expected.json` and re-derived by
`tools/check-fixtures.mjs` groups `p19-protocol`, `p19-locator`, `p19-scans`,
`p19-manifest`, `p19-relay`:

| Fixture | Pins |
|---|---|
| `delivery/protocol-surface.json` | §5/§6/§8/§15 routes, messages, auth/origin requirements, bounds, error→status mapping (§10.1) |
| `delivery/locator-cases.json` | §6 locator expiry/authorization/redaction/cache/cleanup and the negative cases N7–N11 |
| `delivery/upload-bounds.json` | §11 upload/stage bounds and malformed-frame cases N12–N13 |
| `delivery/scan-expectations.json` | §4.4 format-aware validation and §10.2 S1–S7 |
| `delivery/manifest-example.json` | §2 the manifest document, `buildId`/`buildOptionsDigest` recomputation and closure consistency |
| `delivery/input-relay.json` | §8 relay bounds, exclusive-mode clearing, step-range arithmetic and N14–N17 |

## 17. Compatibility and change rules

- Adding a route, a message, an error code, a constant or an artifact class, or
  relaxing a locator/scan/closure rule is a reviewed contract diff (AGENTS.md: an
  accepted contract is binding). The locator's read-only/no-listing/no-traversal
  rules and the §4.3 relative-artifact fetch policy are contract material: a
  runtime loader, a CDN fetch or a wider locator is a security change, not a
  feature.
- The §5.4/§5.4.1 scans and the §4.4 format-aware validators are part of the
  contract: a hit outside the recorded-exception binding conditions is a failure,
  not an exemption.
- `buildId` must never be presented as an engine-independent binary hash; the
  snapshot/build/output identities stay distinct.
- Any conflict between this document and a packet-15/16/17/18 proposal is
  resolved in [`contract-diffs.md`](contract-diffs.md) §3 and applied (or
  rejected) as one Gate E decision per destination section.
