# Thirdlight — Export Contract

Version: 0.1 (normative, pending Gate A acceptance) · Packet 03 · 2026-09-17
Scope: M1 standalone export — the immutable snapshot input, the static
output layout with relative paths, the bundle requirements (same runtime as
play mode, recorded dependency versions), the metadata document, validation
failures, the reproducibility scope, and the explicit non-goals (one small
supported scene first — not a general asset build system).

Companion documents (same milestone, review together):

- `docs/contracts/runtime.md` — the runtime this export bundles, the
  snapshot document shape, the built-in demonstration.
- `docs/contracts/sessions.md` — the play preview the export mirrors (same
  runtime, different snapshot source).
- `docs/contracts/project-model.md` v0.2 — the scene the export validates.
- `docs/contracts/dependencies.md` — the bundle graph check and the stack
  pins recorded in the export metadata.

Inputs read: `AGENTS.md`, `docs/STATUS.md`,
`docs/architecture/charter.md` (§3 product boundaries, §4 deployment and
ownership, §5 module architecture), `docs/decisions/0001-stack-and-deployment.md`
(§1 confirmed decisions, §3 stack, §6 deployment), `docs/environment.md`,
planning packet 03.

Normative keywords **must**, **must not**, **should**, **may** are used in
the RFC 2119 sense.

---

## 1. Scope and ownership

This contract owns:

- The export **input** (one immutable snapshot) and how it is read.
- The **output layout**: files, names, relative-path rule.
- The **bundle requirements**: same runtime as play mode, exact import
  graph, browser-only target, no service dependency.
- The **metadata document** (`meta.json`) — exact fields, including the
  recorded engine/dependency versions.
- The **validation pipeline** and stable failure codes; the
  forbidden-content scan.
- The **reproducibility scope**, stated exactly.
- The M1 non-goals (§8).

This contract does **not** own:

- Runtime behavior (`runtime.md`), the scene format (`project-model.md`),
  the authoring revision (`commands.md`/`workspace.md`), or the play
  preview (`sessions.md`).
- Serving/deployment of the output (packet 13 documents the plain static
  HTTP server; decision 0001 §6) or any publishing (M1: no public hosting —
  decision 0001 §1/§9; charter §3).
- Assets, textures, or any non-M1 content (M2+; §8).

**Normative outcome:** an exported game runs **without** the editor backend,
MCP, or model service — a standalone static web build (charter §1 confirmed
decision; AGENTS.md). Verification is by an independent static server with
the backend stopped (m1-acceptance §1, step 12; packet 12).

## 2. Input: one immutable snapshot

- The export operation is `exportProject(projectId)` — an **admin-scoped
  operation** (sessions.md §6.3: `POST /api/v1/admin/projects/:projectId/export`,
  token scope `admin`; not an MCP tool in M1, not a browser command).
  Implemented by the `exporter` package, invoked by the backend (packet 12).
- The exporter reads the current authoring state **through the workspace
  service** (dependency injection — the backend passes the service instance;
  the exporter never touches files itself and never opens a second
  authority): the project must load (workspace.md §4.3 — strict parse,
  envelope checks, `validateScene`, manifest cross-checks). A load failure ⇒
  `export_scene_invalid` (carrying the workspace/project-model error
  objects, ≤ 10).
- The exporter then constructs the **runtime snapshot** (runtime.md §2):
  `snapshotId = <projectId>@r<revision>`, the normalized scene, the current
  revision. The snapshot is then **frozen for the whole export** — if the
  authoring revision advances between read and completion ⇒
  `export_snapshot_mismatch` (§4, step 2). No partial artifact (§4).
- M1 exports exactly the single scene (project-model §3: one active scene;
  multi-scene is a future persistence + export contract change).

## 3. Output layout (normative)

```text
<exportRoot>/<projectId>@r<revision>/
  index.html          minimal page: <canvas id="game"> + <script src="./js/main.js" type="module">
                      + a small HUD line for the snapshotId and renderer backend
  js/main.js          the esbuild browser bundle (§5)
  snapshot.json       the runtime snapshot document, canonical serialization
                      (project-model §12.2 style: fixed key order, 2-space
                      indent, LF, one trailing newline, no BOM)
  meta.json           the export metadata (§4), canonical serialization
```

- **Relative paths only, normatively:** every reference in every output
  file is relative (`./…`); no absolute paths, no `file://`, no
  `http(s)://` URLs anywhere in the output bytes (§5.4 scan).
- **Serving:** a plain static HTTP server (`python3 -m http.server`, nginx
  static, …). **Opening `index.html` via `file://` is not supported**
  (module loading, relative `fetch`, and the renderer context policy);
  packet 12 documents this explicitly. The backend is never a runtime
  dependency of the output.
- **Output location:** `<exportRoot>` is backend configuration (sessions.md
  §13.7: `/home/dadmin/thirdlight/exports`). The exporter refuses targets
  outside `<exportRoot>` or inside the engine repository tree or any
  project's authoring tree (source/derived separation — packet 04/07
  instruction; `export_output_path_invalid`).
- **Replacement semantics:** the export is a derived, reproducible artifact
  (charter §4: derived outputs are reproducible; browser caches are
  disposable). Re-exporting the same tree replaces it: the exporter writes
  to a fresh temporary directory under `<exportRoot>` and atomically
  replaces the target tree only after the full validation pipeline (§4)
  passes. A failed export leaves the previous tree untouched and removes
  its own temp directory (no partial "successful" artifacts, ever).

## 4. Validation pipeline (before a successful artifact)

The exporter runs, in order. Any failure ⇒ a structured error
(`{ ok: false, error: { code, cls, … } }`, sessions.md §11.2 shape), the
temp directory is removed, and the previous output (if any) is untouched.

| Step | Check | Failure code |
|---|---|---|
| 1 | The project loads and the scene validates (workspace.md §4.3 + project-model §12); the constructed snapshot re-validates (runtime.md §2 boundary validation) | `export_scene_invalid` |
| 2 | The authoring revision is unchanged since the read (re-read through the workspace service after bundle build) | `export_snapshot_mismatch` |
| 3 | The output target is under `<exportRoot>` and outside source/authoring trees | `export_output_path_invalid` |
| 4 | The bundle import graph is exactly the allowed set (§5.2) — esbuild `--metafile` | `export_bundle_graph_forbidden` |
| 5 | The forbidden-content scan on every emitted byte (§5.4) | `export_bundle_forbidden_content` |
| 6 | Output writes succeed (temp dir + atomic replacement) | `export_output_not_writable` |

Success result (bounded):

```json
{ "ok": true, "outputDir": "demo-0001@r12", "snapshotId": "demo-0001@r12",
  "revision": 12,
  "files": { "index.html": 412, "js/main.js": 654321, "snapshot.json": 3801, "meta.json": 618 },
  "scanHits": 0 }
```

(`files` values are byte sizes — measured, not estimated; `scanHits` must
be 0 for a success.)

### 4.1 Stable error codes

`export_scene_invalid` (cls `validation`), `export_snapshot_mismatch`
(`conflict` — re-export), `export_output_path_invalid` (`validation`),
`export_bundle_graph_forbidden` (`internal` — a build/boundary defect,
reported to the operator with the offending module names ≤ 8),
`export_bundle_forbidden_content` (`internal` — carries ≤ 4 hits
`{ pattern, byteOffset, context ≤ 80 chars }`), `export_output_not_writable`
(`unavailable`).

## 5. Bundle requirements (normative)

### 5.1 Same runtime as play mode

`js/main.js` bundles, from the same sources and at the same pinned versions
as the play-preview bundle (dependencies.md §4/§7): the export bootstrap,
`runtime`, `three-adapter`, and `three` (WebGL 2 renderer path first —
decision 0001 §3). **No separate gameplay implementation** (packet 12
instruction; charter §5: the build derives behavior from the same modules).
The demo module (`thirdlight.demo:box-motion`) is included with `modules:
["thirdlight.demo:box-motion"]` fixed in `meta.json` (the M1 export shows
the built-in demonstration — the only M1 behavior; a demo-off export is not
M1).

### 5.2 Exact import graph (verified by the metafile, §4 step 4)

```text
export-bootstrap (packages/exporter/src/export-bootstrap.ts)
  → runtime → project-model (pure, inlined)
  → three-adapter → runtime, three
```

Forbidden in the graph (any node): `backend`, `editor`, `workspace`,
`commands`, `mcp-adapter`, `protocol`, `exporter` (anything beyond its
bootstrap file), and any `node:` builtin (browser platform). The check
runs at build time (packet 12) — this is the export instance of the
dependencies.md §5.3 bundle graph check.

### 5.3 Browser-only target

- esbuild `platform: browser`, the pinned esbuild 0.28.2 (dependencies.md
  §7), no sourcemaps, the default (unminified) output format is M1's
  baseline — minification toggles are not M1 guarantees (§7).
- No Node-only imports: no `node:*`, no `fs`/`path`/`process`/`__dirname`
  usage (covered by the scan, §5.4).
- **No service dependency:** the bundle makes exactly **one** `fetch` —
  the relative `./snapshot.json`. No other network call, no WebSocket, no
  `XMLHttpRequest`, no `import()` of remote code, no authoring-service
  call (charter §1: runs without the editor backend, MCP, or model service).

### 5.4 Forbidden-content scan (normative patterns)

Run over every emitted byte (all four files):

| # | Pattern | Rationale |
|---|---|---|
| a | the configured `authoringOrigin` string (sessions.md §13.7) | no authoring URL |
| b | the configured `previewOrigin` string | no authoring URL |
| c | the substring `/api/v1/` | no authoring-service calls |
| d | `fetch(` — **exactly one** occurrence total, and its target must be the relative `./snapshot.json` | the §5.3 single-fetch rule |
| e | the substring `node:` | no Node-only imports |
| f | `__dirname` or `process.` | no Node leaks |
| g | the substring `/mcp` | no MCP endpoint |
| h | any `http://`, `https://`, or `file://` URL literal | no authoring URLs / absolute locators (project-model §4 forbids them in documents; the bundle is held to the same rule) |
| i | any token material — the configured admin/authoring token **values** (the backend passes the current token set to the exporter for the scan) | no credentials |

Any hit ⇒ `export_bundle_forbidden_content` (the first ≤ 4 hits reported).
**No silent exceptions:** if a pinned dependency (e.g., `three@0.186.0`)
contains a hit pattern, the export fails and the contract must be changed
through review with a recorded exception — a workaround that weakens the
scan is forbidden (AGENTS.md: no workaround that changes a contract's
meaning).

### 5.5 Bootstrap behavior (normative)

1. `fetch("./snapshot.json")` (relative; a failure ⇒ a structured on-page
   message with the error, no silent blank page).
2. `instantiateRuntime` with the frozen snapshot, the built-in registry,
   `modules: ["thirdlight.demo:box-motion"]`, the default clock/driver
   (runtime.md §3.1).
3. `createSceneAdapter` on the page canvas (WebGL 2 path; the selected
   backend is reported on the HUD line — packet 12 records the actual
   browser/render backend).
4. `start()`. Runtime errors surface on-page with the runtime.md error code
   (structured, not a stack dump).
5. No stop/dispose path in M1 export (the page closes ⇒ the tab ends; the
   runtime's disposal rules still apply to teardown — runtime.md §3.4).

## 6. `meta.json` (exact, canonical)

```json
{
  "schemaVersion": 1,
  "type": "thirdlight-export",
  "engineVersion": "0.1.0",
  "projectId": "demo-0001",
  "snapshotId": "demo-0001@r12",
  "revision": 12,
  "exportedAt": "2026-09-17T10:00:00Z",
  "dependencies": {
    "three": "0.186.0",
    "typescript": "5.9.3",
    "esbuild": "0.28.2",
    "runtime": { "fixedStepHz": 120, "modules": ["thirdlight.demo:box-motion"] }
  },
  "scene": { "entityCount": 4, "cameraId": "cam-main", "boxCount": 3 }
}
```

| Field | Rule |
|---|---|
| `schemaVersion` | exactly `1` (M1); metadata-format changes bump it (independent of the scene's logical `schemaVersion` — the workspace.md §4.2 rule applies by analogy). |
| `type` | exactly `"thirdlight-export"` (discriminator; no auto-detection). |
| `engineVersion` | the engine version that built the export (M1 baseline `0.1.0` — project-model §6/§7). |
| `projectId` / `snapshotId` / `revision` | from the snapshot (runtime.md §2); `snapshotId` must equal `<projectId>@r<revision>`. |
| `exportedAt` | UTC second at completion (project-model §7.2 format). The **only** time-varying field (§7). |
| `dependencies` | the exact recorded versions of everything in the bundle (`three`) and the toolchain (`typescript`, `esbuild`) plus the runtime configuration — the "dependency versions" the M0 evidence list requires (charter §9). Values must equal the workspace's pinned installs (dependencies.md §7/§5.6). |
| `scene` | bounded summary: `entityCount`, `cameraId`, `boxCount` (diagnostic only — the scene itself is `snapshot.json`). |

Strict: unknown fields ⇒ invalid metadata (the exporter emits only this
shape; readers reject extras).

## 7. Reproducibility scope (stated exactly)

**In scope (guaranteed, normative):** two exports of the **same snapshot**
(same `snapshotId`) built from the same engine source, with the same
dependency versions (the `dependencies` block), the same esbuild version
and build flags, on the same platform, produce:

- **byte-identical** `snapshot.json` (canonical serialization — project-
  model §12.2 rules) and **byte-identical** `js/main.js` (esbuild is
  deterministic for fixed inputs/versions/flags: no timestamps, no
  sourcemaps, no absolute paths in the output),
- `meta.json` **identical in every field except `exportedAt`**.

**Out of scope (explicitly not claimed):**

- Cross-version reproducibility: a toolchain/dependency version change may
  change bytes; the new `meta.json` `dependencies` line is the record.
- Minification/format stability across esbuild releases (M1 uses one pinned
  version — §5.3).
- Byte-identity of `exportedAt` (it is a timestamp by definition).
- `index.html` is included in the byte-identical claim (it is static per
  §3 — no dynamic content; the snapshotId HUD line is filled at runtime by
  the bundle, not at build time).

**Verification (packet 12, m1-acceptance step 12):** two consecutive
exports of the same revision; `diff` of the trees: empty except
`meta.json:exportedAt`. No machine-specific content (no absolute paths,
hostnames, users, or tokens) anywhere — the §5.4 scan enforces this.

## 8. What is deliberately not in M1 (normative non-goals)

- **One small supported scene first — not a general asset build system.**
  The M1 export supports exactly the project-model registry
  (`transform`/`box`/`camera`, project-model §10): procedural boxes with an
  inline color and the camera. No asset pipeline, no textures, no GLB/
  glTF, no asset identities or reimport (charter §3/M2), no lights, no
  audio files.
- No multi-scene export (project-model §3; a multi-scene persistence
  contract precedes it — workspace.md §12).
- No code splitting, no chunking, no sourcemaps, no minification toggle,
  no i18n, no per-project export configuration UI (M1: the fixed demo-on
  bundle).
- No publishing: no upload, no CDN, no public hosting (decision 0001 §9;
  the operator serves the output with a plain static HTTP server — §3).
- No hosting claim for untrusted code: the M1 export contains only engine
  code (decision 0001 §1: trusted personal projects; user-script execution
  is deferred — runtime.md §7.3).
- No incremental/differential export, no export cache, no versioned
  export archives.
- No WebGPU promise: the export targets the WebGL 2 baseline (decision
  0001 §3; the WebGPU path only after feature coverage is proved).

## 9. Change rules

- After Gate A acceptance, changes to the output layout, `meta.json`
  fields, scan patterns, the import graph, or the reproducibility scope are
  reviewed contract diffs (AGENTS.md).
- `meta.json.schemaVersion` bump rules: a new required field or a meaning
  change ⇒ `2`; the M1 reader (the export page and any tooling) rejects
  unknown major versions with an actionable message (the project-model
  §12.3 unknown-version discipline, applied to metadata).
- The scan patterns (§5.4) are part of the contract: weakening them is a
  contract change, and an unrecorded dependency hit is a failure, not an
  exception (charter §10: a model must not silently edit adjacent
  contracts to make its task pass).