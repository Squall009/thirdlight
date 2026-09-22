# Thirdlight — Module & Dependency Contract

Version: 0.1 (normative, pending Gate A acceptance) · Packet 03 · 2026-09-17
Scope: M1 package workspace — the unit list, the public export surface per
unit, the allowed import edges (node-side and browser-bundle planes), the
forbidden edges, the enforceable boundary checks, the narrow module
registration mechanism, and the recorded approved M1 stack per decision
0001 §3 (including the 2026-09-17 React ruling).

Companion documents (same milestone, review together): the contracts named
as "owns" per unit below (`project-model.md`, `commands.md`, `workspace.md`,
`runtime.md`, `sessions.md`, `export.md`, `gameplay.md`, `presentation.md`).

Inputs read: `AGENTS.md`, `docs/STATUS.md`,
`docs/architecture/charter.md` (§5 module architecture, §10 workflow),
`docs/decisions/0001-stack-and-deployment.md` (§3 stack, §4 workspace, §9
rejected, §10 UI framework ruling), `docs/environment.md` (§1 toolchain,
§2 verified versions), planning packet 03.

Normative keywords **must**, **must not**, **should**, **may** are used in
the RFC 2119 sense.

---

## 1. Scope and ownership

This contract owns:

- The **unit list** and the create-only-when-implemented rule (§2).
- The **public export surface** of each unit (npm `exports` subpaths) (§3).
- The **allowed import edges** — node-side module graphs and
  browser-bundle graphs (§4) — and the **forbidden edges** (§4.3).
- The **enforceable boundary checks** and how they fail the build (§5).
- The **narrow module registration mechanism** — the only M1 extension
  point (§6).
- The **approved M1 stack** with exact pins and the React scope rules
  (§7) — recorded here as the dependency-level statement of decision 0001.

This contract does **not** own: the rationale and owner rulings (decision
0001), the per-unit behavior contracts (the eight contract documents), or the
implementation (packets 04–12).

## 2. Units (suggested initial set; created only when implemented)

npm-workspaces monorepo at the repository root (decision 0001 §4): one
lockfile, `tsconfig.base.json` (strict), root build/typecheck/test scripts,
packages under `packages/<name>`, named `@thirdlight/<name>`.

| Unit | Implements (contract) | Packet | Responsibility (normative boundary) |
|---|---|---|---|
| `project-model` | project-model.md | 05 | schemas, validation, normalization, canonical serialization. Pure data/logic. |
| `commands` | commands.md | 06 | pure command validation/application, change/inverse data, history semantics. No filesystem, transport, UI. |
| `workspace` | workspace.md | 07 | the durable workspace service: the **sole command executor** (`runCommand`), the envelope, ownership, recovery. |
| `runtime` | runtime.md | 08 | the runtime core: lifecycle, snapshot input, mutable state, fixed steps, diagnostics. No three.js, no I/O. |
| `three-adapter` | runtime.md §6/§8/§9, charter §5 "Three.js integration" | 08 | Object3D/material/renderer lifetimes, transform synchronization, renderer selection, screenshot capture. |
| `protocol` | sessions.md | 09 | wire types + strict parsers/validators for HTTP payloads, WS events, and bridge messages; ID syntax constants; allowlists. Pure — no I/O, no Node, no DOM. |
| `backend` | sessions.md (transport), decision 0001 §5/§7 | 09/12 | the HTTP/WS server, session/play routing, the static bundle serving, and the **application services** surface. |
| `editor` | sessions.md (client side), decision 0001 §10 | 10 | the browser UI: React panels, the imperative three.js viewport, the preview embed + bridge wiring. |
| `mcp-adapter` | decision 0001 §5, charter §7 | 11 | the MCP server tools, routed into the backend application services. |
| `exporter` | export.md | 12 | the export builder: snapshot read (via the workspace service), bundle build, scan, metadata. |
| `asset-pipeline` | project-model.md §18 (import profile) | 24 | pure bounded GLB inspection + import recipe over **supplied bytes** — no I/O, no cache writes, no asset-ID decisions |
| `input` | runtime.md §12.5 | 30 | pure action mapping/sampling plus the explicit browser attachment entry — imports runtime types; no authoring transport |
| `physics-rapier` | runtime.md §12.6 | 31 | the concrete 2D collision world + kinematic character adapter over the approved Rapier pin — imports runtime types; no second frame driver |
| `platformer` | runtime.md §12 | 32 | the controller algorithm over injected input/physics ports — runtime types only; no concrete physics, no three.js |
| `behavior-build` | project-model.md §22 | 33 | Node-side, pure: the behavior source parser, static import/dynamic-code analysis, the canonical `BehaviorManifest` and `compileBehavior` — the single shared compiler for play and export — no I/O, no evaluation |
| `platformer-game` | `gameplay.md` | 49 | pure run state, swept gameplay-zone geometry and camera math over runtime ports/types; no concrete physics, input, DOM or three |
| `game-host` | `delivery.md` §§3–5 | 55 | browser-safe DOM HUD, menu/control consumption, injected audio lifecycle and the single shared production module composition; no editor/exporter internals, no fetch, no credential |

**Create only when implemented (normative — charter §5, decision 0001 §4,
AGENTS.md):** a unit that is not yet implemented does **not** exist in the
workspace. Packet 04 creates the root workspace skeleton only; package
directories appear in packets 05–12 as their packets land. No empty stubs,
no placeholder packages, no "future" units. Adding a unit to this list
before its packet is a contract change.

**M2 naming resolution (binding — GE-2).** The Node-side behavior compiler
unit is **`behavior-build`**; the browser-safe behavior host surface (types,
spec/intent validators) lives in **`runtime`**. There is **no** `behaviors`
package and no `behavior-compiler` unit: packet 17's and packet 18's earlier
`behavior-compiler`/`behaviors` rows were superseded and folded into the
`behavior-build`/`runtime` rows above (`docs/planning/m2-contracts/diffs/
dependencies.md` §D19-A). `COMPILER_ID` stays the stable string
`'thirdlight.behavior-compiler'`.

Note to append: `asset-pipeline`, `input`, `physics-rapier`, `platformer` and
`behavior-build` are the plan-§4 units; `runtime` carries the browser-safe
behavior types (naming resolution D19-A). None of them is a second mutation
path: `workspace.runCommand` stays the sole executor, and `behavior-build`
produces a derived artifact, never authoritative state.

## 3. Public export surface per unit

Each package lists **only** its declared public subpaths in its
`package.json` `exports` map. Files not in `exports` are **internal**:
importing them via the package name fails at build time (Node and esbuild
honor the `exports` map) — the primary mechanical boundary (AGENTS.md: no
cross-package internal imports).

| Unit | Public subpaths (M1) |
|---|---|
| `project-model` | `.` — the project-model.md §12.1 entry points: types, `parse*`, `validate*`, `normalize*`, `migrate*`, `serializeCanonical`, `ERROR_CODES`, `KNOWN_VERSIONS`, `parseDocumentBytes` (+ the `ByteParse` type) — the strict pass-1 byte parser (project-model §12.3 pass 1) consumed by the workspace's envelope/manifest/ownership loads (workspace.md §4.3 step 1) |
| `commands` | `.` — types (envelopes), the pure apply/inverse functions, the history model, `ERROR_CODES` |
| `workspace` | `.` — `openWorkspaceService(config) → WorkspaceService` (types, `runCommand`, `query`, the operator operations per workspace.md §11, `ERROR_CODES`) |
| `runtime` | `.` — `instantiateRuntime`, `createSimulationRegistry`, `registerSimulationModule`, `BUILTIN_MODULES`, types (snapshot, diagnostics, module interfaces), `ERROR_CODES` (runtime.md §8) |
| `three-adapter` | `.` — `createSceneAdapter(canvas, opts) → SceneAdapter { renderFrame, captureScreenshot(maxWidth), diagnostics, dispose }`, `ERROR_CODES` |
| `protocol` | `.` — HTTP payload types + strict validators, WS event types + strict validators, bridge message types + strict validators (sessions.md §7/§13.5), ID syntax constants, allowlist constants |
| `backend` | `.` — the server bootstrap (**not importable by any package — the entry point**); `/services` — the **application services** surface: the workspace-service instance wiring, the session registry, the play router, the command/query facades, the admin-operation facades (sessions.md §6) |
| `editor` | `.` — the app entry (**not importable by any package**) |
| `mcp-adapter` | `.` — the MCP server (**not importable by any package**) |
| `exporter` | `.` — `exportProject(ctx) → result` (export.md §4), `ERROR_CODES` |
| `asset-pipeline` | `.` → `inspectGlb(bytes, options)`, `prepareImport`, `importRecipeDigest`, `importMetadataDigest`, `ImportProposal`/`ImportDiagnostic`/`ImportRecipe`, `AssetMetrics`, `ImportJobPort`, `ImportLimits`/`ImportLimitName`, `M2_GLTF_EXTENSION_ALLOWLIST`, `M2_GLTF_PROFILE_LIMITS`, `M2_GLTF_SOURCE_BYTES`, `M2_GLTF_JSON_CHUNK_BYTES`, `M2_GLTF_IMAGE_BYTES`, `M2_GLTF_TOOLCHAIN` |
| `input` | `.` → `mapRawInput`, `attachBrowserInput`, `createStepInputSource`, `StepInputStep`, `DEFAULT_KEYBOARD_MAP`, `GAMEPAD_DEAD_ZONE`, `RawInputSnapshot`, `InputBindingOptions` |
| `physics-rapier` | `.` → `createPhysicsPort(config, signal?)`, `RAPIER_PIN`, `PHYSICS_IMPLEMENTATION`; **non-exhaustive** — the packet-31 additive type-only exports (the init-config/result types and `PhysicsPortError`) are a bounded additive note, not a numbered C31 request |
| `platformer` | `.` → `platformerSpec`, `PLATFORMER_MODULE_ID`, `CONTROLLER_CONSTANTS` |
| `behavior-build` | `.` → `compileBehavior`, `COMPILER_LIMITS`, `COMPILER_ID`, `BehaviorCompileInput`, `BehaviorCompileResult`, `BehaviorManifest`, `CompileDiagnostic`, `PinnedModuleRef`, plus the packet-33 additive canonical-container surface: `SourceGraphContainer`, `parseSourceGraphContainer`, `canonicalContainerText`, `validateBehaviorSource`/`analyzeSourceGraph`, `BEHAVIOR_SOURCE_LIMITS` (**C33-6** accepted with diff, Gate I: these moved here from the `project-model` additions row — `project-model` is a leaf and never implemented them, and packet 33's may-edit set excludes it) |
| `platformer-game` | `.` → `platformerGameSessionSpec`, `platformerGameCameraSpec`, `PLATFORMER_GAME_MODULE_ID`, `stepZones`, `zoneOverlap`, `followCamera`, `CAMERA_CONSTANTS`, `RUN_LIMITS` |
| `game-host` | `.` → `createGameHost`, `GAME_HOST_API_VERSION`, `GAME_HOST_MESSAGES`, `GameHostConfig`, `GameHostObservation`, `GAME_CONTROL_ACTIONS` (the delivery.md §3.1 surface). Internal files are unreachable: the host's DOM, control, audio and composition modules are **not** subpaths, so a wrapper cannot reach past the entry. |
| `runtime` (additions) | `ActionFrame`, `JumpPhase`, `ActionSource`, `createRecordedActionSource`, `SimulationPhase`, `StepContext`, `GameplaySettings`, `PhysicsPort`, `PhysicsStepClient`, `BehaviorSpec`, `BehaviorStepContext`, `BehaviorIntent`, `IntentSet`, `IntentValidation`, `BEHAVIOR_API_VERSION`, `BEHAVIOR_MODULE_PREFIX`, `behaviorModuleId`, `defineBehaviorSpec`, `validateIntent`, `INTENT_LIMITS` (the `platformer` controller constants/window values are owned by the `platformer` row, not re-exported here — C32-2) |
| `project-model` (additions) | `ContentCatalog`, `AssetRecord`, `AssetVersion`, `ImportRecipe`, `AssetMetrics`, `CapturedContent`, `captureContent`, `captureManifest` (packet 35 — sessions.md §17.1; **the single pure owner** of the runtime-content manifest derivation, **C36-2** accepted with diff, Gate I), `validateContent`, `validateProjectV2`, prefab/property/behavior validators, `BehaviorSourceRecord`, `BehaviorTrust`, `resolveGameplaySettings`, `CONTROLLER_CAPSULE`, `M2_SETTINGS_KEYS` |
| `workspace` (packets 23/33/35) | `stageContent`, `inspectStage`, `publishBlob`, `discardStage`, `readBlob`, `readSourceBlob` (**C35-1** accepted with diff, Gate I: a verified, digest-addressed, `O_NOFOLLOW` behavior-container read distinct from the catalog `readBlob(assetId, version)`; §4.1 has no new edge — it uses `fs`/`crypto`, already allowed), `contentIntegrity`, `captureContentView`, `captureManifest` (a **re-export** of the `project-model` derivation — no duplicate implementation, C36-2), `migrateProjectCopy`, `prepareBehaviorSource` |
| `commands` (additions) | `publishAsset`, `createPrefab`, `instantiatePrefab`, `setComponent`, `setSettings`, `setBehaviorProperties`, `publishBehavior`, `acknowledgeBehaviorTrust` request/change/inverse types + `queryAssets`/`queryPrefabs`/`queryBehaviors` — packet 16's op/inverse shapes carry forward unchanged |
| `three-adapter` (additions) | `.` — the GLB realization/resource-owner helpers + an injected byte resolver: the adapter accepts **bytes or a resolver function**, never a token/URL/fetch; GLTFLoader/AnimationClip preview helpers. `./gltf-loader` — the pinned `three@0.186.0` GLTFLoader port (`createGltfLoaderPort`) plus the allowed-extension constants; the root subpath stays **loader-free**, so a bundle that does not load GLBs keeps the export.md §5.4.1 core counts and a graph that pulls the subpath adds exactly the recorded loader row. The M2 GLTF extension allowlist is deliberately duplicated inside `three-adapter` (the `three-adapter → asset-pipeline` edge is forbidden, §4.3); the copy is injectable and must have a **single change point per package**, re-synced whenever the `asset-pipeline` allowlist changes. |
| `protocol` (packet 25/35) | the packet-19 route/message/error types + strict validators (asset-byte reads, content/job/query, locator, bridge v2, input relay) — the sole wire-shape home |
| `backend` `/services` (packet 25/35) | content-upload/job coordination, verified asset-byte reads, the locator artifact serving and the relay routing (through the existing application-services surface) |
| `exporter` (packet 36) | the shared manifest/closure builder + the packet-19 `meta.json` fields |

Rules:

- "Not importable by any package" units are app-level entry points; their
  default subpath may be executed (the process entry, the vitest/tsx runner)
  but not imported.
- The `/services` subpath exists **only** on `backend` and exists **only**
  for `mcp-adapter` (the narrow edge, §4). No other package may import
  `@thirdlight/backend` at any subpath.
- `protocol` is the single home of wire shapes: neither `backend` nor
  `editor` nor `mcp-adapter` defines its own copy of a session/bridge
  message shape (no duplicate protocol definitions — one parser, one
  truth).
- No package exposes or consumes tests/fixtures of another package.

## 4. Allowed import edges (normative)

Two planes are checked separately: the **node-side** module graph (each
package's own compiled dependencies) and the **browser-bundle** graphs
(what esbuild emits). An edge means "may import (via the declared
`exports` subpath only)".

### 4.1 Node-side

| Package | Allowed edges |
|---|---|
| `project-model` | — (leaf; zero project dependencies) |
| `commands` | `project-model` |
| `workspace` | `project-model`, `commands` (+ Node built-ins: `fs`, `path`, `crypto`, `os`) |
| `runtime` | `project-model` |
| `three-adapter` | `runtime`, `three` (+ dev: `@types/three`) |
| `protocol` | `project-model`, `commands` (types; pure code, no I/O) |
| `backend` | `protocol`, `workspace`, `exporter`, `project-model` (types only — the snapshot document, sessions.md §10.1) (+ `ws`; Node built-ins: `http`, `fs`, `path`, `crypto`) |
| `exporter` | `project-model`, `protocol`, `workspace` (types only — the service instance is **injected**, never constructed), `esbuild` (its runtime dependency, §7) |
| `asset-pipeline` | `project-model` (types: `ImportProposal`/recipe/metrics shapes) — pure, **no** `three` and no GLTFLoader (it inspects bytes itself) |
| `input` | `runtime` (types) |
| `platformer` | `runtime` (types) |
| `physics-rapier` | `runtime` (types) + `@dimforge/rapier2d-compat` (the approved pin, §7) |
| `behavior-build` | `project-model` (types + `parseDocumentBytes` — a **value** edge used for the strict container parse; **C33-7** accepted with diff, Gate I: the earlier row named `parseSourceGraphContainer`/`validateDeclaration`, which do not exist in `project-model`), `esbuild` (the pinned parser, §7). `COMPILER_LIMITS` carries the contract's nine bounds **plus** `ownedTransforms`, `properties` and `declarationBytes` (the declaration-bound limit names the compiler re-checks itself, C33-7). |
| `platformer-game` | `runtime` (types) — pure; no concrete physics, input, DOM or three |
| `game-host` | `runtime` (types + `instantiateRuntime`/`createSimulationRegistry`/`registerSimulationModule` values), `platformer`, `platformer-game`, `input` (types + `attachBrowserInput` value), `three-adapter` (**types only** — the adapter/resource interfaces and the injected byte resolver). The concrete `physics-rapier` port, the `three` canvas and the audio implementation are **injected**, so `game-host` has no value edge to them. |
| `workspace` (additions) | `behavior-build` (**types only** — the compiler instance is **injected**, like the exporter's workspace service) and `asset-pipeline` (**types only**, injected job port) |
| `backend` (additions) | `asset-pipeline` (constructs the inspector and injects it), `behavior-build` (constructs/injects the compiler), `exporter` (already) |
| `exporter` (additions) | `asset-pipeline` (types only; closure resolution via the injected workspace reads bytes as blobs) |
| `three-adapter` (additions) | `runtime` (unchanged), `three` incl. the GLTFLoader/animation subpaths — still **no** network/storage edge |
| `mcp-adapter` | `protocol`, `backend` (**the `/services` subpath only** — §4.3), `@modelcontextprotocol/sdk` |
| `editor` | `protocol`, `runtime`, `three-adapter`, `three` (the imperative viewport is direct three.js — decision 0001 §10), `project-model` (types), `commands` (types), `react`, `react-dom` (+ dev: `@types/react`, `@types/react-dom`, `@types/three`) |
| `editor` (play-preview entry, **C35-3** accepted with diff, Gate I) | `packages/editor/src/preview/preview-bootstrap.ts` is a second, separately checked entry whose direct edges are the §4.2 play-preview graph: `editor/src/preview/**`, `protocol`, `runtime`, `three-adapter`, `project-model`, `input`, `platformer`, `physics-rapier`, `three` (incl. the GLTFLoader subpath). It may **not** reach the editor UI (`packages/editor/src/ui/**`, `session/**`, `viewport/**`) or `commands`; the one recorded computed `import()` targets a manifest-declared relative locator artifact path (§5.1). |

Notes:

- `backend` does **not** import `runtime` or `three-adapter` node-side: the
  backend builds the snapshot document (via `workspace`/`project-model`
  types) and serves pre-built static bundles (sessions.md §13.7) — the
  runtime runs only in the browser and the export bundle.
- `editor` imports `commands`/`project-model` for **types only** (the
  command envelopes and scene types); it never calls workspace or command
  execution code — the editor's only mutation path is the HTTP API
  (sessions.md §6.1; charter §6: commands are the only mutation path).
- `exporter` reads the scene through the **injected** workspace service
  (dependency injection — no hidden global services, §4.3); node-side it
  imports workspace **types only**. Its *bundle* plane (§4.2) is where the
  runtime/three-adapter enter, as build inputs.
- Node built-in usage is per-row above; no other package imports Node
  built-ins (the browser packages — `runtime`, `three-adapter`, `editor`,
  `protocol` — are browser-safe by construction; `runtime`'s two DOM
  guards are per runtime.md §9).

### 4.2 Browser-bundle graphs (esbuild `--metafile` verified)

| Bundle | Entry | Allowed graph (exact) |
|---|---|---|
| **editor bundle** (`dist/editor/`) | `packages/editor/src/index.tsx` | `editor/**`, `protocol`, `runtime`, `three-adapter`, `project-model`, `commands`, `three` (incl. the GLTFLoader subpath for viewport/preview realization), `react`, `react-dom` |
| **play-preview bundle** (`dist/preview/`) | `packages/editor/src/preview/preview-bootstrap.ts` (the M2 wrapper; the M2 play graph is unchanged and **loader-free** — root subpath only) and, for M3 plays, `packages/editor/src/preview/preview-m3.ts` (the M3 wrapper, a second separately checked entry — the C35-3 pattern; the composition is `game-host`) | `editor/src/preview/**` (that directory only), `game-host`, `platformer-game`, `protocol` (the pure wire-types package — bridge messages; §3), `runtime`, `three-adapter` (root; the M3 entry additionally reaches the `./gltf-loader` subpath — the model byte loader port, M4 `delivery.md` §2), `project-model`, `input`, `platformer`, `physics-rapier` (injected by the wrapper), `three` (incl. the GLTFLoader subpath — the M2 bundle's graph does not include it), plus the **linked behavior outputs** of the snapshot |
| **export bundle** (export output) | `packages/exporter/src/export-bootstrap.ts` (the M1/M2 wrapper; the M1/M2 export graphs are unchanged and **loader-free** — root subpath only) and, for M3 (`manifestVersion 2`) exports, `packages/exporter/src/export-bootstrap-m3.ts` (the M3 wrapper — the exact one-file M3 exporter list, `export.md` §5.2 as corrected by C64-5; the composition is `game-host`) | `exporter/src/export-bootstrap.ts` or `exporter/src/export-bootstrap-m3.ts` (the profile's own file only), `game-host`, `platformer-game`, `runtime`, `three-adapter` (root; the M3 entry additionally reaches the `./gltf-loader` subpath — the model byte loader port, M4 `delivery.md` §2), `project-model`, `input`, `platformer`, `physics-rapier` (injected by the wrapper), `three` (incl. the GLTFLoader subpath — the M1/M2 bundles' graphs do not include it), plus the **linked behavior outputs** of the snapshot and the **declared asset artifacts read as relative runtime resources** |

- The play-preview and export bundles are the **runtime bundles** the
  charter/AGENTS.md protect: they **must not** transitively include
  editor/server/MCP code — i.e. no `backend`, `workspace`, `commands`,
  `mcp-adapter`, `exporter` (beyond its bootstrap file), or any Node
  builtin module may appear in their graphs. `protocol` is permitted in
  the preview bundle because it is pure shared wire types — not server
  code (recorded exception, normative: `protocol` contains no I/O, §3).
- The preview/export bootstraps live in their app packages on purpose
  (one source for the bridge wiring, next to the editor it speaks to); the
  metafile check whitelists exactly those files and forbids everything
  else from those packages in the runtime bundles. **C35-3 (accepted with
  diff, Gate I):** the play-preview entry's direct edges are the §4.2 row
  above (checked separately from the editor-UI row, §4.1), and its one bounded
  computed `import()` — the runtime-resolved, manifest-declared relative locator
  artifact path for a linked behavior output (delivery §4.3) — is the single
  recorded exception to the static-specifier rule (§5 check 1). All other
  preview imports are static specifiers in the allowed graph.
- The editor/preview bundles are built by the workspace build script (dev
  context — esbuild is a dev tool there, §7); the export bundle is built
  at export time by the `exporter` (esbuild is its runtime dependency,
  §7). Same pinned versions, same flags family; the differences (entry,
  no-bridge) are recorded in `meta.json` (export.md §6).
- **`behavior-build` is never in a bundle graph** (Node-side only); neither
  is `asset-pipeline` (inspection happens at authoring/import time; the
  preview/export read committed bytes).
- **GLTFLoader is the pinned `three@0.186.0` package's own subpath** — no new
  dependency, no new pin (§7). Only `three/examples/jsm/loaders/GLTFLoader.js`
  (+ the animation loader used for clip preview) may appear; a different
  `examples/jsm` module is a reviewed addition. **M4 record (C64-6):** the
  M3 play-preview and M3 export bundles are the two bundles that import the
  `three-adapter` `./gltf-loader` subpath (the model byte loader port); the
  M1/M2 bundles' graphs do not include it. **M4 tooling records (C66-1/C67-4):**
  `tools/game-build.mjs` (the game's build entry, distribution.md §6) and the
  backup/verify/restore/create + budget tools (reliability.md §1) are
  plain-Node scripts (`node:*` builtins only) — not packages, in no
  `dependencies` map, no lockfile change; none of them joins `npm run build`
  or any bundle graph; the kit's `tools/` allowlist and the §7 pins are
  unchanged.
- **Preview/export artifact reads are not imports.** `content/sha256/<digest>`
  and `behaviors/<digest>.js` enter the closure as build inputs
  (export.md §5.2); at runtime the bundle fetches only the manifest-declared
  relative artifact paths. The bundle-graph check therefore still forbids
  `backend`, `workspace`, `commands`, `mcp-adapter`, `editor`,
  `behavior-build`, `asset-pipeline` and every Node builtin.
- **Linked behavior outputs are static bundle inputs, never dynamic imports.**
  A behavior output is an artifact produced by `compileBehavior` and consumed by
  the per-snapshot bundle build (packet 33): the generated entry statically
  includes each published output for the snapshot's `outputDigest`s. The emitted
  bundle therefore contains **no `import()`**, no behavior-specific `fetch`, and
  no behavior source text; the forbidden-graph check applies to the whole graph
  including the linked outputs (`behaviors.md` §5.5/§8.7, export.md §5.2).
- The editor bundle must not include `behavior-build` or any behavior output:
  the editor edits declarations, never code (`behaviors.md` §9.7).
- **The M3 runtime bundles share one host composition.** Both the play-preview
  and the export bundle include `game-host` and `platformer-game` and build the
  game through the single public `createGameHost` entry (delivery.md §3.1/§3.2);
  neither bundle may contain `exporter` internals (`export-composition.ts`) or
  editor internals. The **editor** bundle is unchanged and must not contain
  `game-host`: the editor UI cannot import it (the §4.3 rule).

### 4.3 Forbidden edges (normative, any plane)

- `runtime → three.js` (the runtime core is three-free — runtime.md §9,
  packet 08 instruction).
- `runtime → commands | workspace | protocol | backend | editor | mcp-adapter | exporter` (the runtime knows only the snapshot and `project-model`).
- `runtime → Node built-ins | fetch/XHR/WebSocket | filesystem` (runtime.md §9).
- `three-adapter → backend | editor | workspace | commands | protocol` (the adapter reads only the runtime's public state, runtime.md §6).
- `editor → workspace | backend | mcp-adapter | exporter` (the editor talks to the backend only over HTTP/WS — an import edge would create a second mutation/observation path).
- `backend → editor` (serving the static bundle ≠ importing editor code).
- `mcp-adapter → editor`; `mcp-adapter → backend` at any subpath other than `/services` (§3); `mcp-adapter → workspace` directly (the harness reaches authoring state only through the backend services — no alternate mutation engine, charter §5/§7).
- `exporter → backend | editor` (the exporter reads via the injected workspace service and writes only to its output tree).
- `asset-pipeline → any I/O | three | three-adapter | runtime | editor | backend | workspace | commands | behavior-build` (bytes in, proposal out).
- `behavior-build → runtime | three | three-adapter | editor | backend | workspace | commands | mcp-adapter | any browser global` (pure parser only).
- `input → editor | protocol | backend | workspace | commands | three | three-adapter | physics-rapier | platformer | behavior-build` (pure mapping + one browser attachment entry; it knows `runtime` types only).
- `platformer → three | three-adapter | physics-rapier | input | editor | backend | workspace | commands` (injected ports only).
- `physics-rapier → three | three-adapter | editor | backend | workspace | commands | protocol` (runtime types + the approved Rapier pin only).
- `runtime → asset-pipeline | behavior-build | physics-rapier | input | platformer` (the runtime receives injected ports/specs; it never imports a concrete adapter or compiler).
- `three-adapter → workspace | backend | protocol | editor | asset-pipeline | behavior-build` (the adapter gets bytes or an injected resolver; it holds no token, no URL and no fetch).
- `platformer-game → input | physics-rapier | three | three-adapter | runtime concrete adapters | editor | backend | workspace | commands | protocol | DOM | Web Audio` (pure rules over runtime types and injected ports only).
- `game-host → editor (any subpath) | backend | workspace | commands | protocol | mcp-adapter | exporter (any subpath) | asset-pipeline | behavior-build | physics-rapier (concrete) | three (direct) | any Node builtin` (the browser-safe host receives every concrete dependency by injection).
- **Editor-UI rule (normative, plan-review PR-5):** `packages/editor/src/ui/**`, `packages/editor/src/session/**` and `packages/editor/src/viewport/**` may **not** import `@thirdlight/game-host`; only `packages/editor/src/preview/**` may. §4.2's `editor/**` wildcard would otherwise admit DOM and Web Audio into the editor bundle. This is a forbidden edge like any other, not a style rule.
- `exporter → backend | editor | asset-pipeline` (closure resolution stays on the injected workspace reads).
- Behavior source may not import engine modules as values and may not use `fetch`/`XMLHttpRequest`/`WebSocket`/`eval`/`import()` (`behaviors.md` §4/§5.5). This is enforced by the compiler's static analysis and output scan, **not** by the boundary checker (the compiled output is not a package graph); the boundary checker additionally forbids the unit edges above.
- Any package → another package's internal files (unreachable by the
  `exports` map — §3), or → another package's tests/fixtures.
- **No hidden global services (normative):** cross-package state sharing
  happens only through function arguments and return values (injection).
  Module-level mutable singletons that another package depends on are
  forbidden; `globalThis` assignments are a boundary-check review item
  (§5.1 check 4).
- **No duplicate mutation path (normative):** the workspace service's
  `runCommand` (workspace.md) is the sole command executor. `backend`'s
  HTTP handlers and `mcp-adapter`'s tools both route into it; no other
  package calls `commands`' pure apply functions to mutate state
  (packets 06/07/09 instruction: no second authority).

## 5. Enforceable boundary checks (normative; packet 04 implements)

The checks are machine-enforced and fail the build (non-zero exit, listing
offending `file:line`). Packet 04 implements checks 1, 2, 5, 6; packets
10/12 implement 3–4 as their bundles exist.

1. **Static import-graph check** (`tools/check-boundaries.mjs`, plain Node
   — no new dependency): scan every implemented package's `.ts`/`.tsx`
   sources for `import`/`export … from`/dynamic `import()` specifiers;
   resolve package-name specifiers against each package's `exports` map;
   assert every cross-package edge is in §4 (including the
   `mcp-adapter → backend` subpath restriction and the node-side table).
   A violation names the file, line, specifier, and the rule broken.
   **One bounded computed-`import()` rule (C35-3, accepted with diff, Gate
   I — replaces the earlier checker carve-out):**
   `packages/editor/src/preview/preview-bootstrap.ts` may contain exactly one
   computed dynamic `import()` whose argument is the runtime-resolved,
   manifest-declared **relative locator artifact path** for a linked behavior
   output (delivery §4.3). The check allows that single form; every other
   computed/absolute/dynamic specifier (including a second computed import and
   any import of a non-`file:`/non-relative target) is a violation, as is an
   import that would add a package edge outside §4.2.
2. **Negative fixture proof** (packet 04, one-time): a temporary source in
   `runtime/` importing `three` (and one importing
   `@thirdlight/editor`) must make check 1 fail; the fixture is removed
   afterwards and the proof recorded in handoff 04 (packet 04 instruction).
3. **Bundle graph check** (packets 10/12): esbuild `--metafile` on each
   bundle of §4.2; attribute every emitted module to its workspace package
   (or `node_modules` package) and assert the graph is exactly the allowed
   set. A forbidden package in a runtime bundle ⇒ the build fails (export
   instance: export.md §4 step 4, code `export_bundle_graph_forbidden`).
4. **Forbidden-content scan** (packets 10/12, for the runtime bundles):
   the export.md §5.4 patterns over the emitted play-preview (packet 10)
   and export (packet 12) bundles. The export.md §5.4.1
   recorded-exception table (pinned `three@0.186.0` identity + exact
   counts under the export.md §5.3 pinned option set — including the
   §5.4.1 GLTFLoader subpath row when a bundle graph pulls in
   `./gltf-loader`) applies to **both**
   bundles under its binding conditions; a violation fails the build
   (non-zero exit, offending pattern + context), and for the export
   instance is reported as `export_bundle_forbidden_content` (export.md
   §4 step 5).
5. **Type-level strictness:** the root `tsconfig.base.json` is `strict:
   true` (decision 0001 §2/§3); per-package `tsconfig`s extend it; the
   root `typecheck` script runs `tsc --noEmit` across the workspace with
   the pinned TypeScript 5.9.3 (the editor's TSX is handled by the esbuild
   TSX loader per decision 0001 §10 — §7).
6. **Dependency pinning:** one root lockfile (npm, decision 0001 §3);
   package `dependencies` use **exact pinned versions** (no ranges) from
   the §7 table; a root `check-deps` script compares `npm ls --depth=0`
   against the pins — a version drift fails the check. Any version change
   is an owner-approved decision change (decision 0001 §3 status column;
   packet 04: report a concrete decision change instead of substituting
   silently).

Additional rule (normative, code review + check 1): a package that is not
yet implemented may not appear in any package's `dependencies` (the
lockfile cannot reference a non-existent workspace package — the check
catches premature wiring, §2).

M2 additions to this check list (packets 24–36):

7. **Runtime port isolation** (packets 29–32): a probe that makes `runtime`
   import `input`, `platformer`, `physics-rapier`, `asset-pipeline` or
   `behavior-build` fails check 1; the three adapter/compiler units are also
   probed against importing `runtime` **as a value** (types only).
8. **Behavior unit edges**: a probe that makes `runtime` import
   `behavior-build` fails the check, and a probe that lets `behavior-build`
   import `workspace` or `backend` fails the check. Both probes are removed
   after verification (disposable).
9. **Compiler purity probe**: a fixture-level probe asserts `compileBehavior`
   reads no path by running it with a filesystem accessor that throws; the
   compiler takes bytes only.
10. **Artifact-read containment** (packets 25/35): a probe that makes
    `three-adapter` or the preview bootstrap perform a non-relative fetch, or
    fetch an undeclared path, fails the bundle/manifest closure check.
11. **Locator read-only probe** (packet 35): a probe requesting a locator path
    outside the declared manifest set (traversal, listing, another `contentId`)
    must yield `path_rejected` and no bytes.
12. **Host-composition containment** (packets 49/55/58): check 1 must fail a
    disposable probe where `packages/editor/src/ui/**` imports
    `@thirdlight/game-host` (D42-5), and check 3 must fail if `game-host` or
    `platformer-game` appears in the editor bundle or if an `exporter` internal
    module appears in a runtime bundle. Both probes are removed afterwards.
    Packets 58/60 re-measure the export.md §5.4.1 counts and the §17.5 fetch list
    changed by these edges and request bounded re-review if the measured text
    differs (delivery.md §3.4/§6.5).

## 6. Module registration mechanism (narrow; normative)

The **only** M1 extension point is the runtime's **simulation module
registry** (runtime.md §5/§7):

```text
const registry = createSimulationRegistry();
registerSimulationModule(registry, "thirdlight.demo:box-motion", boxMotionSpec); // compile-time linked
const { runtime } = instantiateRuntime({ snapshot, registry,
  modules: ["thirdlight.demo:box-motion"], … });
```

- **Name syntax:** `^thirdlight\.[a-z0-9]+:[a-z0-9-]+$` (namespaced,
  stable, log-safe).
- **M1 registry contents: exactly one module** — `thirdlight.demo:box-motion`
  (the built-in moving-box demonstration, runtime.md §7), a source module
  of the `runtime` package, linked at build time.
- **Code-level, not content-level (normative):** registration happens in
  engine source, at build time. The `modules` selection at instantiate
  accepts only IDs present in the provided registry (unknown ID ⇒
  `config_invalid`, runtime.md §8); there is **no** string-to-code
  resolution, no dynamic `import` of project content, no file- or
  URL-sourced modules, no per-project module data.
- Duplicate registration of a name ⇒ `config_invalid` (the registry
  rejects at registration time).
- This mechanism is the recorded hook for M2+ behavior modules (input
  simulation, physics, the platformer controller): they enter as new
  engine modules through a reviewed contract diff (their own step/drop
  semantics per runtime.md §5.2/§11), **not** as user-loaded scripts.
  Arbitrary user-script execution remains deferred until its execution
  boundary is reviewed (runtime.md §7.3) — this registry is deliberately
  insufficient for that (it cannot load untrusted code), and that
  insufficiency is normative for M1.
- **Behavior modules** register through this same mechanism, one spec per
  `behaviorId`, with `id = "thirdlight.behavior:" + behaviorId`
  (`^thirdlight\.[a-z0-9]+:[a-z0-9-]+$` still holds because behavior IDs match
  project-model §5.1's ID syntax), phases `["intent"]` or `["intent","transform"]`
  and `transformOwners` = the container's `ownedTransforms`
  (`behaviors.md` §9.1/§9.6). Registration is still compile-time code with no
  string-to-code resolution and no dynamic `import`: the spec for a published
  behavior is produced by the host bootstrap from the **already linked** output
  (`behaviors.md` §8.4/§9.1). `source: null` behaviors register nothing. There
  is no file-, URL- or content-loaded module in M2, and this registry remains
  deliberately insufficient for untrusted code (`behaviors.md` §2.4).

The M2 registry contents (phases and transform owners per module):

| Module ID | Phases | Transform owners | Registered when |
|---|---|---|---|
| `thirdlight.demo:box-motion` | (M1 single-phase) | its own box entities | M1 demo selected |
| `thirdlight.platformer:controller` | `["controller","transform"]` | the controller entity | the scene has exactly one controller entity |
| `thirdlight.behavior:<behaviorId>` | `["intent"]` or `["intent","transform"]` | the container's `ownedTransforms` | the snapshot declares the behavior with a non-null `source` and the host linked its `outputDigest` |

`physics-rapier` and `input` are **injected ports**, not registered modules;
registration remains compile-time code with no string-to-code resolution.
- Non-goals: the component registry is the project-model's fixed table
  (project-model §10 — no runtime component registration); the
  three-adapter's component→Object3D mapping is a fixed M1 table inside the
  adapter (no registration API in M1); there is no editor-plugin or
  panel-registration mechanism in M1 (decision 0001 §10 scope guard:
  React owns the fixed packet-10 panel set).

## 7. Approved M1 stack (recorded per decision 0001 §3, incl. the 2026-09-17 ruling)

Pins (registry-verified 2026-09-16/17 — `docs/environment.md` §2;
**nothing installed until packet 04**; a change requires owner approval,
decision 0001 §3):

| Item | Pin | Scope / consumer | Status |
|---|---|---|---|
| Node | 22 (host v22.22.1) | backend, exporter, tooling | decision 0001 §3 |
| TypeScript | **5.9.3** (strict) | all packages | owner-confirmed 2026-09-16 (decision 0001 §3) |
| Package manager | npm 9.2.0 (workspaces, one lockfile) | workspace | decision 0001 §3 (no pnpm/bun — §9) |
| Backend HTTP | built-in `node:http` | `backend` | decision 0001 §3 (no web framework — §3/§9) |
| WebSocket | `ws@8.21.3` | `backend` | decision 0001 §3 |
| 3D | `three@0.186.0` (+ `@types/three@0.186.0` dev) | `three-adapter` (bundles: preview, export) | decision 0001 §3 (WebGL 2 path first; WebGPU only after coverage is proved) |
| Build/bundle | `esbuild@0.28.2` (incl. the TSX loader) | workspace build script (dev) + `exporter` (runtime dep) | decision 0001 §3 |
| Tests | `vitest@5.0.1` (dev) | workspace | decision 0001 §3 |
| MCP (backend side) | `@modelcontextprotocol/sdk@1.30.0` | `mcp-adapter` | decision 0001 §3/§5 |
| **UI framework** | **React: `react@19.3.0`, `react-dom@19.3.0`, `@types/react@19.3.0`, `@types/react-dom@19.3.0` (dev)** | **`editor` only** | **owner ruling 2026-09-17 — decision 0001 §10** (supersedes the original "none for M1") |
| Physics | see the Rapier row below | `physics-rapier` | M2 selection proposed by decision 0002 §1; Gate E approves, packet 31 installs |
| 2D physics | `@dimforge/rapier2d-compat@0.20.0` (Apache-2.0; integrity `sha512-FFYwGrfJov7d5kn4fxblG/ip5C+sYQL+Jl/hqLvDvu4BcMD/Mhrz7cTvnZTtuIRDXY8CLuraObqB/prip4wdWQ==`) | `physics-rapier` (bundles: preview, export) | **approved at Gate E 2026-09-18 (owner pre-approval (autonomous M2 build instruction, 2026-09-18); final manual review pending); desktop evidence open; lockfile only at packet 31** — selection per decision 0002 §1 |
| GLB loading | **no new pin**: the pinned `three@0.186.0` package's `examples/jsm/loaders/GLTFLoader.js` (+ its animation subpath) | `three-adapter` (bundles: preview, export) | decision 0001 §3; version-bound to the existing `three` pin — a `three` change re-measures export.md §5.4.1 |
| Behavior compiler | **no new pin**: the already-pinned `esbuild@0.28.2` + `typescript@5.9.3` | `behavior-build` (Node) | packet 18 §D18-8; no lockfile change |

**Exact Rapier integrity value (verbatim, not abbreviated):**
`sha512-FFYwGrfJov7d5kn4fxblG/ip5C+sYQL+Jl/hqLvDvu4BcMD/Mhrz7cTvnZTtuIRDXY8CLuraObqB/prip4wdWQ==`
(decision 0002 §1.2, recorded at packet 14). It is approved at Gate E and
installed into the lockfile only at packet 31; no packet installs it
incidentally. A change to `esbuild`, `typescript`, `runtime`'s `apiVersion` or
the export.md §5.3 option set changes the compiled output bytes and therefore
the `outputDigest`/`manifestDigest` of published behaviors: it is a reviewed
contract change (`behaviors.md` §12.4), announced in `meta.json`.

**React scope rules (normative, binding for all editor work — decision
0001 §10 restated at dependency level):**

- React is the **only permitted UI framework** in M1. No other UI library
  (no preact, no vue, no svelte, no UI component framework) may be added to
  any package without an owner ruling.
- React is **scoped to `editor` panels** (decision 0001 §10 boundaries):
  the hierarchy/entity list, transform inspector, toolbars,
  connection/save status, and play controls (packet 10 scope). `editor` is
  the **only** package whose `dependencies` may include
  `react`/`react-dom` (+ their `@types/*` as devDependencies).
- **`three-adapter` and `runtime` stay framework-free** (normative): the
  three.js scene graph, camera controls, gizmos, picking, and the play
  preview are imperative three.js / pure logic outside React rendering;
  React never instantiates or mutates Object3Ds (decision 0001 §10);
  scene mutation flows only through editing commands (charter §6 — no
  duplicate scene mutation paths).
- **No web framework anywhere** (normative): the backend is
  `node:http` + `ws` (decision 0001 §3/§9 — the "no web framework"
  rejection stands; the 2026-09-17 ruling changed the *editor UI*
  framework only, and is recorded as decision 0001 §10).
- Build: esbuild handles TSX natively (the TSX loader); the ruling adds no
  new build tool (decision 0001 §10) — consistent with the §5.5/§7
  toolchain (TypeScript 5.9.3 for typecheck, esbuild 0.28.2 for build).
- Scope guard (decision 0001 §10): the ruling selects a framework; it does
  **not** expand the editor UI beyond packet 10's scope ("no decorative
  dashboard, prefab browser, graph editor, or unrelated panels").

## 8. What is deliberately not in M1 (normative non-goals)

- No plugin system, no public API versioning scheme beyond the M1 contracts
  (the contract documents + `exports` maps are the API).
- No monorepo tooling beyond npm workspaces + root scripts (no lerna/nx/
  turbo — unrequested frameworks, AGENTS.md).
- No per-genre engine forks or template modules (charter §5: module
  presets/layouts are M4).
- No workspace-level code generation, no code formatting tool in the M1
  toolchain (formatting is not an acceptance criterion).
- No pre-created units: the §2 table is a plan; the lockfile reflects only
  implemented packages (checked, §5.6).
- No behavior compiler, no behavior host package and no behavior source of any
  kind in M1. M2 declares them here and implements them at packets 33–36
  (`behaviors.md` §15).
- No `npm`-installed or URL-loaded project modules, no build plugins, no shell
  hooks and no server-side source evaluation (`behaviors.md` §2.2/§5.4).
- No GLB importer, no asset pipeline, no packet-17/18/19 package: M2 declares
  `asset-pipeline`, `input`, `physics-rapier`, `platformer` and `behavior-build`
  here and implements them at packets 24/30/31/32/33.
- No locator, no content byte route, no input relay and no v2 bridge in M1
  (`sessions.md` §16–§18); M1's single-fetch/no-content-fetch policy is
  unchanged until the packet-19 export diff is accepted.

## 9. Change rules

- After Gate A acceptance, adding/renaming a unit, changing a public
  subpath, adding an import edge, or weakening a forbidden edge is a
  reviewed contract diff (AGENTS.md: accepted contracts are binding).
- Version changes to any §7 pin require the owner-approval path
  (decision 0001 §3) and a `meta.json`/`check-deps` update in the same
  review (export.md §7: dependency versions are recorded export evidence).
- The React scope rules are owner-ruling-derived (decision 0001 §10):
  any relaxation (a second UI framework, React outside `editor` panels,
  React inside `runtime`/`three-adapter`) requires a new owner ruling —
  not a contract edit by a packet.
- The boundary checks (§5) are part of the contract: a check that cannot
  be satisfied is a contract/implementation conflict to document (AGENTS.md),
  never a silently disabled check.
- Adding a behavior unit edge, changing `behavior-build`'s allowed imports,
  weakening §4.3's behavior bullets or making `runtime` load/link/compile
  behavior code is a reviewed contract diff (AGENTS.md: accepted contracts are
  binding).
- `compileBehavior`'s purity (bytes in, bytes out; no filesystem, network,
  clock, randomness, evaluation or shell) is contract material: relaxing it is
  the "server-side source evaluation/build hook" the packet-18 acceptance line
  forbids, not a performance optimisation (`behaviors.md` §5.4).
- The bundle-linking rule (static inputs, no `import()`) may not be relaxed
  into a runtime loader: that would change export.md §5.3/§5.4's single-fetch
  and scan binding and is a reviewed change with a re-measured scan table.
- Adding a unit, an edge, a bundle-graph row or a pin, weakening a forbidden
  edge, or making a runtime bundle fetch a non-declared resource is a reviewed
  contract diff (AGENTS.md). The Rapier pin is approved at Gate E and installed
  only at packet 31; no packet installs it incidentally.
- `behavior-build` is the single behavior compiler for play and export (naming
- `game-host` and `platformer-game` are the only M3 units added by packet 42; a
  later unit, subpath, edge or bundle-graph row is a reviewed contract diff.
- The editor-UI rule of §4.3 and the 58/60 re-measurement requirement are part
  of the PR-5 acceptance, not guidance: creating `game-host` without them, or
  widening a §5.4.1 exception instead of re-measuring it, reopens this diff.
  resolution §2); adding a second compiler or a runtime loader reopens this
  diff and `behaviors.md` §5.4's purity rule.