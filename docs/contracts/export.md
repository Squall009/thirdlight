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
- **M2: the snapshot is captured into a runtime-content manifest.** The exporter
  still reads one authoring state through the injected workspace service and
  freezes it; it then derives the immutable runtime-content manifest (delivery
  §2) — scene digest, resolved asset versions, behavior outputs, required engine
  modules, recipe/toolchain versions and build identity — from that single
  capture. The manifest is the export's structural input; a revision or
  resolved-digest change after capture is `export_snapshot_mismatch` (§4 step 2).
**M3: the manifest is `manifestVersion` 2** (delivery.md §2). It additionally
binds the resolved six-key gameplay settings, the frozen `content.game` block
and the media identity (audio cue/role resolution) by digest, so one captured
envelope fixes every runtime-affecting value. A v1 manifest keeps its accepted
meaning and is never upgraded in place; a re-capture writes a new v2 document
with a new `capturedAt`/`buildId`. Late edits, reimports and failed/cancelled
builds follow delivery.md §2.6 — the previous output and every pinned Play
artifact set stay byte-unchanged.
  The manifest is **not** an engine-independent binary hash, and `snapshotId` is
  never presented as one.

## 3. Output layout (normative)

```text
<exportRoot>/<projectId>@r<revision>/
  index.html          minimal page: <canvas id="game"> + <script src="./js/main.js" type="module">
                      + a small HUD line for the snapshotId and renderer backend
  js/main.js          the esbuild browser bundle (§5)
  manifest.json       the immutable runtime-content manifest (delivery §2),
                      canonical serialization
                      (project-model §12.2 style: fixed key order, 2-space
                      indent, LF, one trailing newline, no BOM)
  scene.json          the exact `sceneDigest` preimage bytes: the canonical
                      normalized scene document at the captured revision
                      (**C36-1** accepted with diff, Gate I; the exported page
                      cannot instantiate the runtime without it, and the
                      bootstrap digest-verifies it against `manifest.sceneDigest`)
  content/sha256/<digest>   every reachable committed asset version (immutable,
                      byte-identical to the authoritative blob)
  behaviors/<outputDigest>.js   every reachable compiled behavior output
  meta.json           the export metadata (§4), canonical serialization
```

- `snapshot.json` is **superseded** by `manifest.json` for M2 exports; an M1
  export is unchanged and keeps `snapshot.json` (`meta.json.schemaVersion 1`).
- The relative-paths/no-absolute-locator rule is unchanged and now covers the
  new directories; the closure rule (delivery §9) requires every declared
  artifact to be present and every present artifact to be declared.

- **Relative paths only, normatively:** every reference in every output
  file is relative (`./…`); no absolute paths, no `file://`, no
  `http(s)://` URLs anywhere in the output bytes (§5.4 scan).
- **Serving:** a plain static HTTP server (`python3 -m http.server`, nginx
  static, …). **Opening `index.html` via `file://` is not supported**
  (module loading, relative `fetch`, and the renderer context policy);
  packet 12 documents this explicitly. The backend is never a runtime
  dependency of the output.
- **The export declares its own policy.** `index.html` carries a
  `<meta http-equiv="Content-Security-Policy">` with
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';
  img-src 'self' data:; style-src 'self'; font-src 'none'; worker-src 'none';
  object-src 'none'; base-uri 'none'; form-action 'none'`. The static host is
  **not** relied on to send a CSP header, so the game boots under a plain
  `python3 -m http.server`/nginx. `'wasm-unsafe-eval'` is required so the pinned
  Rapier WASM compiles (packet-38 evidence, delivery.md §6.1) and permits
  WebAssembly compilation only — never `eval`. `frame-ancestors` is omitted: it
  is ignored in a meta policy and the export is never framed by the engine.
- **MIME classes.** The serving host must send `text/html; charset=utf-8`,
  `text/javascript; charset=utf-8`, `application/json`, `application/wasm`,
  `model/gltf-binary` and `audio/wav` for the corresponding files, plus
  `X-Content-Type-Options: nosniff`. The export ships no server config; an
  incorrect MIME is a deployment failure, not a silent fallback.
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
- **Non-root static closure.** The whole tree is servable under an arbitrary
  non-root prefix (acceptance example `/games/beacon-reach/`): every reference is
  relative (`./…`), there is no leading-`/` reference, no `<base>` element and no
  absolute locator. The declared-artifact set of `manifest.json` **is** the
  emitted closure (every declared artifact present, every present artifact
  declared), including model and audio bytes; the M3 manifest v2 keys add **no**
  side-car file and therefore no new path.

## 4. Validation pipeline (before a successful artifact)

The exporter runs, in order. Any failure ⇒ a structured error
(`{ ok: false, error: { code, cls, … } }`, sessions.md §11.2 shape), the
temp directory is removed, and the previous output (if any) is untouched.
The bundle build itself is not a numbered step: it runs between steps 1 and
2 (after the snapshot is frozen, before the step-2 revision re-read), and
its defects surface at steps 4 and 5.

| Step | Check | Failure code |
|---|---|---|
| 1 | The project loads and the scene validates (workspace.md §4.3 + project-model §12); the constructed snapshot re-validates (runtime.md §2 boundary validation) | `export_scene_invalid` |
| 2 | The authoring revision is unchanged since the read (re-read through the workspace service after bundle build) | `export_snapshot_mismatch` |
| 3 | The output target is under `<exportRoot>` and outside source/authoring trees | `export_output_path_invalid` |
| 4 | The bundle import graph is exactly the allowed set (§5.2) — esbuild `--metafile` | `export_bundle_graph_forbidden` |
| 5 | The forbidden-content scan on every emitted byte (§5.4) | `export_bundle_forbidden_content` |
| 5a | The manifest validates (strict §2 shape; `buildId` recomputes; every declared path is relative and present; every reachable asset/behavior/module is declared) | `export_manifest_invalid` |
| 5b | Format-aware validation of every emitted artifact (delivery §4.4): GLB container/URI scan, WASM magic/pin scan, JS/text pattern scan, relative closure | `export_bundle_forbidden_content` / `scan_forbidden_content` |
| 5c | Engine-fetch closure: the emitted bundle's fetch targets equal exactly the declared artifact set + one manifest read (delivery §4.3) | `export_bundle_graph_forbidden` |
| 6 | Output writes succeed (temp dir + atomic replacement) | `export_output_not_writable` |

Success result (bounded):

```json
{ "ok": true, "outputDir": "demo-0001@r12", "snapshotId": "demo-0001@r12",
  "revision": 12,
  "files": { "index.html": 412, "js/main.js": 654321, "snapshot.json": 3801, "meta.json": 618 },
  "scanHits": 0 }
```

(`files` values are byte sizes — measured, not estimated; `scanHits`
counts hits **outside** the §5.4.1 recorded-exception scope and must be 0
for a success.)

### 4.1 Stable error codes

`export_scene_invalid` (cls `validation`), `export_snapshot_mismatch`
(`conflict` — re-export), `export_output_path_invalid` (`validation`),
`export_bundle_graph_forbidden` (`internal` — a build/boundary defect,
reported to the operator with the offending module names ≤ 8),
`export_bundle_forbidden_content` (`internal` — carries ≤ 4 hits
`{ pattern, byteOffset, context ≤ 80 chars }`), `export_output_not_writable`
(`unavailable`), `export_manifest_invalid` (`validation` — carries ≤ 10 model
errors and the manifest path), `export_build_unavailable` (`unavailable` — the
derived build failed; the previous output tree is preserved) and
`scan_forbidden_content` (`internal` — a format-aware scan hit, ≤ 4 hits; the
shared code with the play build, sessions.md §11.3).

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

**Behavior modules use the same pipeline in play mode and in the export.** Both
bundles statically link the same engine modules and the same behavior output
artifacts for the snapshot's published `outputDigest`s, against the same pinned
engine versions (`behaviors.md` §8.7, dependencies.md §4.2). There is **no
separate gameplay implementation** for exported behaviors and no runtime loader:
a behavior output is a build input, exactly like `runtime` and `three-adapter`
are. A behavior with `source: null` links nothing and contributes nothing, so
M1-style scenes and declaration-only behaviors export exactly as today. Because
the two bundles are produced from the same (snapshot, `sourceDigest`s, engine
pins, pinned option set), the same engine modules behave identically in play and
in the exported game.
- **One shared host composition.** The export and the play preview build the game
  through the same public browser-safe entry `createGameHost` (delivery.md §3.1):
  one registry/module set (runtime built-ins + `platformer` + `platformer-game` +
  linked behavior outputs), one host update loop, one HUD/control/audio owner.
  The wrappers differ only in platform specifics (page config, relative reads,
  canvas, bridge). No gameplay logic, controller, camera or run-state owner is
  duplicated, and the resolved manifest settings are passed to **both** the
  runtime and the physics configuration (delivery.md §3.3) — the M2
  `export-composition.ts` wiring is reused behind this entry, not forked.

### 5.2 Exact import graph (verified by the metafile, §4 step 4)

```text
export-bootstrap (packages/exporter/src/export-bootstrap.ts)
  → runtime → project-model (pure, inlined)
  → three-adapter → runtime, three
  → input / platformer / physics-rapier (packet 17) → runtime (types) [+ the approved physics pin]
  → the linked behavior outputs of the snapshot (static build inputs, one per published `outputDigest`)
  → the manifest's declared artifact set as static build inputs:
    content/sha256/<digest> (read by the bootstrap as relative artifacts),
    behaviors/<outputDigest>.js
```

**M2 bundle entry (C36-5 accepted with diff, Gate I).** For an M2
(`schemaVersion 2`) export the graph entry is
`packages/exporter/src/export-bootstrap-m2.ts`, and the `exporter` files the
graph may contain are **exactly three** — no wildcard, no fourth file:

```text
packages/exporter/src/export-bootstrap-m2.ts   the M2 page bootstrap
packages/exporter/src/export-composition.ts    the shared play/export runtime composition (§5.1)
packages/exporter/src/export-page.ts           the import-free page-text module
```

The M2 graph additionally injects the two generated virtual modules
(`thirdlight:export-artifacts`, `thirdlight:export-behaviors`) that carry the
manifest's declared artifact set and the statically linked behavior outputs;
they are build inputs, never runtime fetches.
**M3 entry (packet 58).** For an M3 (`manifestVersion 2`) export the graph adds
`game-host` and `platformer-game` and the composition lives in the public
`game-host` entry, not in an `exporter` internal. The M3 exporter file list is
**exactly one file** (no M2 three-file list, no wildcard; M4 C64-5 correction —
the M3 entry file is `export-bootstrap-m3.ts`, the accepted implementation, and
the M3 preview entry is `packages/editor/src/preview/preview-m3.ts` — the
graph check enforces `M3_EXPORTER_FILES = ['packages/exporter/src/export-bootstrap-m3.ts']`):

```text
packages/exporter/src/export-bootstrap-m3.ts   the M3 page bootstrap/wrapper
@thirdlight/game-host                          the shared composition + HUD/control/audio
@thirdlight/platformer-game                    the pure run/zone/camera module
```

`packages/exporter/src/export-composition.ts` may remain as the accepted M2
entry for M2 exports; an M3 export must not require an `exporter` internal for
gameplay wiring (delivery.md §3.2). The forbidden list below is unchanged and
now also forbids `game-host` importing `exporter` internals.

Forbidden in the graph (any node): `backend`, `editor`, `workspace`,
`commands`, `mcp-adapter`, `protocol`, `exporter` (anything beyond the exact
per-profile file list), `asset-pipeline`, `behavior-build`, any `node:` builtin
(browser platform), and — for M3 — an `exporter` internal reachable from
`game-host`. The check
runs at build time (packet 12) — this is the export instance of the
dependencies.md §5.3 bundle graph check. Additionally forbidden: any behavior
output that transitively pulls `behavior-build`, `editor`, `backend`,
`workspace`, `commands`, `mcp-adapter`, `protocol` or a Node builtin; and any
behavior output that contains `import(`, `fetch(` (other than the single §5.5
bootstrap fetch), `XMLHttpRequest`, `WebSocket`, `eval(`, `new Function` or a
pinned-path absolute locator (`behaviors.md` §5.5). `behavior-build` itself is
**never** in this graph: it runs at preparation time, not at export time. The
metafile check keeps its exact-input rule: the linked outputs are inputs, and
the graph must contain no other module from the `exporter` package beyond the
profile's exact file list (`export-bootstrap.ts` for M1; the three files of the
M2 row above for M2) and no `esbuild` dependency of the compiler.

### 5.3 Browser-only target — pinned build options (normative)

The export bundle is built with esbuild 0.28.2 (dependencies.md §7)
using **exactly** this option set — every other option at its esbuild
0.28.2 default; no additional CLI flags, `define`s, banners, loaders,
aliases, or `external`s:

```text
bundle: true
platform: "browser"
format: "iife"
treeShaking: false
sourcemap: false
minify: false
```

- `format: "iife"` is pinned **explicitly**: esbuild 0.28.2's default
  output format is IIFE **even for ESM entries** (verified 2026-09-17 —
  the default-flag and `format: "iife"` builds are byte-identical). The
  IIFE payload is loaded by §3's `<script type="module">` tag (a valid
  module script — no top-level `import`/`export` is required). Because
  the format is IIFE, the bootstrap must **not** use top-level `await`
  (esbuild rejects it in IIFE output): §5.5 step 1 uses a `.then()`
  chain.
- `treeShaking: false` is pinned so the pinned `three@0.186.0` content
  appears in the emitted bundle verbatim: the §5.4.1 recorded-exception
  counts are then **exact** (no tree-shaking slack). Bundle size is not
  an M1 criterion (§8: one small supported scene).
- The **same pinned option set applies to all three bundles** of
  dependencies.md §4.2 (editor, play-preview, export): same pinned
  esbuild version and flags, only the entry point and the allowed graph
  differ (the editor bundle's `.tsx` files use esbuild's default TSX
  loader — no option change).
- **The compiled behavior output is an intermediate, not a §5.3 bundle.** It is
  produced by `compileBehavior` with a pinned, closed option set
  (`bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  treeShaking: false, sourcemap: false, minify: false`, `behaviors.md` §5.4) and
  is then consumed as an input by the §5.3 build of the final bundle — the
  emitted `js/main.js` (and the play-preview bundle) still uses exactly §5.3's
  option set, `format: "iife"` included. The intermediate's
  `outputDigest`/`manifestDigest` are recorded in `meta.json` so the
  whole chain is reproducible; the §5.4/§5.4.1 scans run over the **final**
  emitted bytes, which include the intermediates' bytes.
- No Node-only imports: no `node:*`, no `fs`/`path`/`process`/`__dirname`
  usage (covered by the scan, §5.4).
- **No service dependency:** the bundle fetches only **relative artifacts
  declared by its own `manifest.json`** — one manifest read plus one read per
  unique declared artifact path (delivery §4.3), all same-origin,
  relative to the output tree. For an M1-style closure (no assets, no
  source-bearing behaviors) this reduces to the M1 rule with `./manifest.json`
  replacing `./snapshot.json`. Other `fetch(` occurrences may appear in the
  emitted bytes only from the pinned three.js loader code and only as recorded
  in the §5.4.1 recorded-exception table. Still: no absolute/remote URL, no
  engine WebSocket, no engine `XMLHttpRequest`, no `import()` of remote code,
  no authoring-service call (charter §1: runs without the editor backend, MCP,
  or model service).

### 5.4 Forbidden-content scan (normative patterns)

Run over every emitted byte (all four files):

| # | Pattern | Rationale |
|---|---|---|
| a | the configured `authoringOrigin` string (sessions.md §13.7) | no authoring URL |
| b | the configured `previewOrigin` string | no authoring URL |
| c | the substring `/api/v1/` | no authoring-service calls |
| d | `fetch(` — **exactly one initiated by engine code**: the export bootstrap's relative `./snapshot.json` (the preview bootstrap initiates none — its snapshot arrives via the checked bridge, sessions.md §13.4); occurrences inside the pinned three.js code are bound by the §5.4.1 recorded-exception table | the §5.3 single-fetch rule |
| e | the substring `node:` | no Node-only imports |
| f | `__dirname` or `process.` | no Node leaks |
| g | the substring `/mcp` | no MCP endpoint |
| h | any `http://`, `https://`, or `file://` URL literal | no authoring URLs / absolute locators (project-model §4 forbids them in documents; the bundle is held to the same rule) |
| i | any token material — the configured admin/authoring token **values** (the backend passes the current token set to the exporter for the scan) | no credentials |
| j | the substrings `XMLHttpRequest` and `WebSocket` | no network mechanism other than the single relative `fetch` (§5.3) |

The letters are stable contract identifiers (**C33-4**, accepted with diff,
Gate I): **a–j** are the table above (shared with the compiler's output scan,
`planning/m2-contracts/behaviors.md` §5.5); the behavior-only patterns continue
the alphabet as **k** `import(`, **l** `eval(`, **m** `new Function`, **n**
`Function(`, **o** `require(` and **p** for a surviving pinned engine module ID
in a compiled output. Patterns a/b/i are optional host inputs (origin/token
values); the rest are always evaluated. No count or hit is claimed for
behavior bytes here.

Any hit ⇒ `export_bundle_forbidden_content` (the first ≤ 4 hits reported)
— except occurrences covered by the §5.4.1 recorded-exception table under
its binding conditions. A dynamic `import()` of remote or workspace
content is enforced by the step-4 metafile graph check (every imported
module appears in the graph) together with pattern h — not by a text
pattern.

**Behavior outputs are scanned as part of the emitted bytes.** The §5.4 patterns
(a–j) and the §5.4.1 recorded-exception table apply unchanged to the final bundle,
including the linked behavior output bytes; additionally, each prepared behavior
output is scanned at preparation time by the compiler's own output scan
(`behaviors.md` §5.5) so a forbidden pattern is refused *before* it can reach
an export. Whether a given behavior output hits a pattern is a per-build
measurement, not contract text: no measured count for behavior bytes and no
zero-count claim for them is made here.

**Format-aware validation replaces the text-only scan for non-JS artifacts**
(delivery §4.4): `content/sha256/<digest>` GLB blobs are validated as
containers (glTF magic/version/chunk table, strict JSON chunk, every `uri`
rejected unless it is an embedded/declared name with no scheme, leading `/`,
`..` or backslash); a separately emitted WASM artifact is validated by magic,
version, declared SHA-256 pin and an empty host-import allowlist. The a–j
patterns and the §5.4.1 counts apply to the **JS/text bytes** (including the
linked behavior outputs); applying them to a binary payload is explicitly not
the rule. Pattern i (token values) gains **locator values**: the exporter is
given the active `contentId`s and any occurrence is a hit.

#### 5.4.1 Recorded-exception table — pinned `three@0.186.0` (normative; Gate A follow-up F1)

The patterns are absolute for **engine code** (bootstrap, `runtime`,
`three-adapter`, `project-model`, `protocol`). The pinned `three@0.186.0`
carries inert occurrences of four patterns inside its own shipped code.
Rather than weaken the scan, the contract records them as a
**version-bound exception with exact counts**, re-measured 2026-09-17
under the §5.3 pinned option set on the full-core three bundle (entry
`import * as THREE from 'three';` — the `three` package resolves to
`build/three.module.js`, which re-exports `build/three.core.js`; emitted
1,777,857 bytes):

| Pattern | Recorded count (pinned flags) | Content (verified inert, 2026-09-17) |
|---|---|---|
| d `fetch(` | 3 | two real fetch calls in three's loader code (`FileLoader`, `ImageBitmapLoader` — executable only if the engine requests a file load; the M1 engine never does) + one string literal in a `warn()` message |
| f `process.` | 3 | two string literals in `warn`/`warnOnce` messages + one doc comment; `__dirname`: 0 |
| h `http://` + `https://` | 3 + 23 = 26 | `http://`: one XHTML-namespace string literal (`createElementNS`) + two doc comments; `https://`: 23 doc-comment reference links (wikipedia.org, w3.org, khronos.org, developer.mozilla.org, github.com); `file://`: 0 |
| j `XMLHttpRequest` | 3 | three doc comments (JSDoc `withCredentials` references); `WebSocket`: 0 |
| a/b/c/e/g/i | 0 | absent — a/b/i are the configured origin/token values passed to the scan; all six patterns verified 0 hits in the pinned three measurement |

**GLTFLoader subpath row (packets 35/36; measured 2026-09-19 under the §5.3
pinned option set).** When a bundle graph includes the
`three/examples/jsm/loaders/GLTFLoader.js` subpath (via the `three-adapter`
`./gltf-loader` subpath), the same pinned `three@0.186.0` install contributes
additionally:

| Pattern | Recorded addition | Content (verified inert) |
|---|---|---|
| h `https://` | +12 (⇒ 35 total with the full-core counts above) | GLTFLoader's own doc-comment reference links |
| `GLTFLoader` | ×37 | the loader's own class/identifier occurrences (measured bundle 2 137 831 bytes) |
| d/f/j/a/b/c/e/g/i | 0 additional | no additional fetch/process/XMLHttpRequest/origin/token hits |

**Additional measured rows (C35-7 / C36-6, accepted with diff, Gate I).**
These are recorded exceptions with the same binding conditions as the rows
above (pinned identity/flags/reference build; never a blanket allowance):

| Item | Recorded addition | Content (verified inert) |
|---|---|---|
| `@dimforge/rapier2d-compat@0.20.0` (the approved §7 pin) | pattern d `fetch(` +1 | one inert `fetch(` occurrence in the compat wrapper's inlined-WASM/loader code; it is never executed (packet 31's adapter inlines the WASM bytes and the port receives bytes). Re-measured per export build, not assumed. |
| the exporter's mandatory §2.3 trust-notice text | patterns j `XMLHttpRequest`/`WebSocket` counted from the exact fixed notice constant | the page must present the trust notice verbatim before starting; the notice **names** those mechanisms as forbidden, so the string is by design. Counted from the frozen constant, never a wildcard. |
| the C36-1 `./scene.json` read | pattern d `fetch(` +1 | one relative `fetch("./scene.json")` in the export bootstrap; the bytes are digest-verified against `manifest.sceneDigest`. Counted once. |
| behavior outputs are **static** inputs | 0 additional fetches | compiled behavior outputs enter the bundle as build inputs (`behaviors/<outputDigest>.js` and the generated virtual module) and are **not** fetched at runtime; §4.2's "declared artifact set" includes them as static bytes, while §17.5's runtime fetch list covers assets and the manifest/scene only. |

**Binding (normative — the exception applies only when all hold):**

1. **Identity:** the bundled `three` is exactly `three@0.186.0` — npm
   tarball `three-0.186.0.tgz` SHA-256
   `61eeff9d7616005c9a481c796f52287d81fbbbc0d55eaca5565322924252c1aa`
   (registry integrity
   `sha512-cr/fIM2ddMSVbYVgkfD4jLJv7Fh/8ZTjvo+7gQeSVGUZHxpx9FDwoL5iC7hUz/LiRA8wMbqfnb90xKfm1/HHkQ==`).
   Any other version ⇒ the table is void and the unmodified scan applies
   (a version change is an owner-approved decision change plus a contract
   diff that re-measures this table — dependencies.md §9).
2. **Flags:** the build uses exactly the §5.3 pinned option set.
3. **Reference build:** a reference full-core three bundle (the entry
   above, same pinned options) re-scans to exactly the table's counts —
   re-verifying the record against the current install before the real
   bundle is judged.
4. **Real-bundle exact counts:** patterns a/b/c/e/g/i: 0; pattern d:
   the recorded baseline (3 from the pinned three core, +1 per the Rapier row
   when that graph includes the physics pin) **plus the counted engine call
   sites**: in the **export** bundle the literal `fetch("./manifest.json")`
   exactly once, `fetch("./scene.json")` exactly once (C36-1), and one read per
   unique declared asset path; in the **preview** bundle the same baseline +
   loader/Rapier rows as apply + the counted preview call sites (one
   `./manifest.json`, one `./scene.json`, one read per unique declared asset
   path, and the linked behavior outputs are static — not fetches). **C35-6**
   (accepted with diff, Gate I) supersedes the earlier literal "exactly 3 + 0 in
   the preview bundle", which was written for the M1 preview that fetched
   nothing; the scan now asserts the recorded baseline + the applicable
   exception rows + the counted per-bundle call sites, never a blanket
   allowance. patterns f/h/j: exactly the table's counts **plus** the applicable
   rows above. Any deviation ⇒ `export_bundle_forbidden_content` (export) / the
   bundle check fails the build (preview).
**M3 addition (packet 42):** `game-host` initiates **no** fetch and adds **0**
occurrences for patterns a/b/c/e/g/i and 0 additional for d/f/h/j; Web Audio
(`AudioContext`) is not a scanned pattern (pattern j covers `XMLHttpRequest`/
`WebSocket` only). `content.game`/`settings`/`media` are **embedded** in
`manifest.json`, so there is no `game.json` side-car and no extra fetch. The
count remains the recorded baseline + the applicable exception rows + the
counted per-bundle call sites; no new exception row and no blanket allowance are
proposed. Packets **58/60** must re-measure this table and the §17.5 fetch list
on the real bundles and record the result; if the measured text differs, they
request bounded re-review rather than widening an exception.

**Reference-build entry (U-4 ACCEPT — owner pre-approval (autonomous M2 build
instruction, 2026-09-18); final manual review pending).** Binding 3's
"reference full-core three bundle" is materialized with the entry
`import * as THREE from 'three'; console.log(THREE.REVISION);`. Under the
pinned esbuild 0.28.2 option set the bare `import * as THREE from 'three';`
elides to a 15-byte empty IIFE (unused namespace imports are dropped even with
`treeShaking: false`), which would make binding 3 unsatisfiable. The table's
counts and binding conditions are **unchanged** and remain the binding record;
this clause only fixes how the described reference bundle is produced.

**No silent exceptions (unchanged rule):** a hit outside the binding
conditions is a failure, not an exception; the table is re-measured and
reviewed as a contract diff whenever the three pin or the pinned option
set changes (AGENTS.md: no workaround that changes a contract's meaning;
charter §10).

*Measurement note (recorded 2026-09-17):* the Gate A review's initial
measurement recorded `process.` ×27 for the same build; the re-measurement
under the pinned option set shows the contract pattern `process.` (with
the dot) occurs **3** times — the ×27 counts the substring `process`,
which also matches doc-comment prose ("processing",
"post-processing", …). This table binds the pattern as written in §5.4.

### 5.5 Bootstrap behavior (normative)

1. `fetch("./manifest.json")` and `fetch("./scene.json")` (relative,
   digest-verified; a failure ⇒ a structured on-page message with the error, no
   silent blank page). The M1 single-fetch rule is unchanged for an M1 export
   (`./snapshot.json`).
2. Resolve the M3 module set and registry and build the game through
   `createGameHost` (delivery.md §3.1): the frozen snapshot, the resolved
   `manifest.settings` passed to `instantiateRuntime({ settings })` **and** to
   the physics configuration, the manifest-declared asset reads, and the
   manifest's cue/role identity. The M1 demo module selection is unchanged for an
   M1 export (`modules: ["thirdlight.demo:box-motion"]`).
3. `createSceneAdapter` on the page canvas (WebGL 2 path; the selected backend is
   reported on the HUD line — packet 12 records the actual browser/render
   backend) and inject it into the host; the host owns no renderer import.
4. The host starts in `awaitingStart`: the title/HUD is rendered, no movement
   step runs, and the menu channel accepts start/replay/mute without awaiting a
   tick (delivery.md §4.5). Runtime errors surface on-page with the runtime.md
   error code (structured, not a stack dump). Ready means the title screen
   loaded — not that gameplay started.
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
  "scene": { "entityCount": 4, "cameraId": "cam-main", "boxCount": 3 },
  "behaviors": [
    { "behaviorId": "behavior-0002", "sourceDigest": "<64 hex>",
      "sourceByteLength": 1234, "manifestDigest": "<64 hex>",
      "outputDigest": "<64 hex>", "outputByteLength": 4096,
      "apiVersion": 1,
      "enginePins": [ { "id": "@thirdlight/runtime", "version": "0.2.0", "apiVersion": 1 } ] }
  ],
  "behaviorTrust": { "acknowledgedSourceDigests": [ "<64 hex>" ] },
  "manifest": {
    "manifestVersion": 2, "snapshotId": "demo-0001@r12", "revision": 12,
    "sceneDigest": "<64 hex>", "contentDigest": "<64 hex>",
    "gameDigest": "<64 hex>", "settingsDigest": "<64 hex>",
    "mediaDigest": "<64 hex>",
    "buildId": "<64 hex>", "buildOptionsDigest": "<64 hex>"
  },
  "licenses": [ { "id": "three", "version": "0.186.0", "license": "MIT", "source": "npm" } ],
  "artifacts": {
    "assets": { "count": 2, "bytes": 8192 },
    "behaviors": { "count": 1, "bytes": 4096 },
    "total": { "count": 3, "bytes": 12288 }
  },
  "outputDigest": "<64 hex>"
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

Rules for the M2 additions: `schemaVersion` becomes exactly `2` for an M2 export
(a new required field or meaning change; the M1 reader rejects unknown majors with
an actionable message). `behaviors` is ascending by `behaviorId` and contains only
behaviors the snapshot uses with a non-null `source` (declaration-only behaviors
are omitted — they link nothing); `enginePins` is ascending by `id` and identical
to the pins the bundle was built with (`behaviors.md` §5.3); `behaviorTrust` lists
the digests whose acknowledgment the export relied on. **C36-4 (accepted with
diff, Gate I):** this is a **structural** enforcement, not a build-time read of
`content.behaviorTrust.entries` — the publication-time gate (`behavior_trust_unacknowledged`,
`behaviors.md` §2.3/§8.7) means a source-bearing behavior record cannot exist
un-acknowledged, so the export records exactly the `sourceDigest`s of the
source-bearing behaviors it emits; the editor-facing bounded trust read is
`sessions.md` §19.4 / `project-model.md` §22.5 (C34-4). An export of a snapshot
whose asserted trust disagrees with that structural set fails with
`behavior_trust_unacknowledged` and produces no artifact (`behaviors.md`
§2.3/§8.7); the exported page must present the §2.3 trust notice before starting
(packet 36). `licenses` is one entry per bundled
dependency/artifact, ascending by `id`; `artifacts` counts/bytes are measured from
the emitted tree.
For an M3 export `manifest.manifestVersion` is `2` and the block carries the
three block digests; they are copies of the manifest's own fields, never
re-derived independently (the manifest is authoritative — delivery.md §2.3).
`buildId` stays distinct from `snapshotId` and `outputDigest`.

**`outputDigest` (C36-3, accepted with diff, Gate I) — exact definition.**
`outputDigest` is the SHA-256 (lowercase hex, UTF-8) of the **sorted emitted
closure listing**: every emitted file **except `meta.json`** (the listing cannot
include the document that contains it), in ascending relative-path order, each
contributing the line `path\ndigest\nbyteLength\n` — path relative to the output
root with `/` separators, `digest` the lowercase-hex SHA-256 of that file's exact
bytes, `byteLength` the decimal byte count. There is no other separator,
preamble or trailing byte. It is a distinct identity from `snapshotId` and
`buildId`. An M2 export of an M1-style snapshot still emits this shape (empty
`content/**`/`behaviors/**`).

Strict: unknown fields ⇒ invalid metadata (the exporter emits only this
shape; readers reject extras).

## 7. Reproducibility scope (stated exactly)

**In scope (guaranteed, normative):** two exports of the **same snapshot**
(same `snapshotId`) built from the same engine source, with the same
dependency versions (the `dependencies` block) — including the §5.4.1
pinned `three` identity — and esbuild 0.28.2 with the **exact pinned
option set of §5.3**, on the same platform, produce:

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

**M2 addition (normative):** two exports of the same captured manifest, same
artifact bytes and same pins/options produce byte-identical `manifest.json`,
`content/**`, `behaviors/**` and `js/main.js`; `meta.json` is identical in
every field except `exportedAt`; `outputDigest` (which excludes `exportedAt` by
construction) is therefore identical. GLB/WASM artifact bytes are copied
verbatim, never re-encoded, so the closure is byte-reproducible.

**M2 capture-second condition (C36-7, accepted with diff, Gate I).** The
`buildId` preimage includes `capturedAt` (`sessions.md` §17.1.1), so the claim
above holds for two exports captured **in the same UTC second**. Exports in
different seconds are not byte-identical: `manifest.json` differs in
`capturedAt` and `buildId`, and `outputDigest` (which covers `manifest.json`)
differs in consequence; `meta.json` additionally differs in `exportedAt`. To
reproduce a specific `buildId`/`outputDigest`, capture with the same
`capturedAt` (committed evidence records the capture second). This is the
chosen adjudication of C36-7; the alternative (dropping `capturedAt` from the
preimage) is not applied.
**M3 two-tree rule (packet 42, normative).** The accepted claim is checked by
exporting twice into **two separate output trees** and hashing each tree **before
any overwrite**. Only the contracted timestamp carriers are normalized —
`manifest.json#capturedAt` and `meta.json#exportedAt` — and `buildId` is then
re-derived; the trees must be byte-identical afterwards. The M3 additions
(`gameDigest`, `settingsDigest`, `mediaDigest`, `settings`, `game`, `media`) are
timestamp-free and must match **without** normalization. `outputDigest`
(excluding `meta.json`) remains a separate identity and is never equated with
`buildId`.

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
  audio files. This §8 list is scoped to an M1 export. An M3 export
  (manifestVersion 2) delivers declared GLB/WAV artifacts, asset identities and
  the reviewed light/surface data; it still adds no asset pipeline authoring, no
  texture pipeline, no background music and no remote/CDN media.
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
- No behavior code, compiler, loader or behavior artifact in an M1 export, and no
  export-time compilation: M2's behavior outputs are prepared before the command
  and linked as static inputs from packet 33 on (`behaviors.md` §8.7).
- No worker/WASM/iframe execution boundary for behaviors and no preemption
  claim: the exported game runs trusted behavior code in its own main context,
  with no hard timeout and no hostile-code sandbox (`behaviors.md` §2.2).
- No CDN, capability-URL or absolute-locator export; no service worker; no
  range/resumable download; no export of a `contentId` or any authoring
  credential (delivery §9).
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
- Adding a `meta.json` field, changing the behavior-artifact pin format, letting
  an export load behavior code at runtime (any `import()`/fetch of code), or
  dropping the trust-acknowledgment precondition is a reviewed contract diff
  (`behaviors.md` §8.3/§12).
- §5.3's pinned option set, §5.4's pattern table and §5.4.1's recorded-exception
  counts are unchanged by packet 18 and keep their re-measurement rule: a
  behavior output that changes the emitted counts is a build finding, not a
  contract amendment.
- Changing the output layout, the manifest shape, the fetch-closure rule, the
  format-aware validators or the `meta.json` fields is a reviewed contract diff;
  the §5.4.1 counts keep their re-measurement rule.
- Superseding `snapshot.json` with `manifest.json` is a versioned layout change:
  an M1 export (schemaVersion 1) stays readable and unchanged; a reader must
  branch on `meta.json.schemaVersion`, never on file presence.
- The scan patterns (§5.4) are part of the contract: weakening them is a
  contract change, and a hit outside the §5.4.1 binding conditions is a
  failure, not an exception (charter §10: a model must not silently edit
  adjacent contracts to make its task pass).