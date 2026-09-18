# Thirdlight — Module & Dependency Contract

Version: 0.1 (normative, pending Gate A acceptance) · Packet 03 · 2026-09-17
Scope: M1 package workspace — the unit list, the public export surface per
unit, the allowed import edges (node-side and browser-bundle planes), the
forbidden edges, the enforceable boundary checks, the narrow module
registration mechanism, and the recorded approved M1 stack per decision
0001 §3 (including the 2026-09-17 React ruling).

Companion documents (same milestone, review together): the contracts named
as "owns" per unit below (`project-model.md`, `commands.md`, `workspace.md`,
`runtime.md`, `sessions.md`, `export.md`).

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
0001), the per-unit behavior contracts (the six contract documents), or the
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

**Create only when implemented (normative — charter §5, decision 0001 §4,
AGENTS.md):** a unit that is not yet implemented does **not** exist in the
workspace. Packet 04 creates the root workspace skeleton only; package
directories appear in packets 05–12 as their packets land. No empty stubs,
no placeholder packages, no "future" units. Adding a unit to this list
before its packet is a contract change.

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
| `mcp-adapter` | `protocol`, `backend` (**the `/services` subpath only** — §4.3), `@modelcontextprotocol/sdk` |
| `editor` | `protocol`, `runtime`, `three-adapter`, `three` (the imperative viewport is direct three.js — decision 0001 §10), `project-model` (types), `commands` (types), `react`, `react-dom` (+ dev: `@types/react`, `@types/react-dom`, `@types/three`) |

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
| **editor bundle** (`dist/editor/`) | `packages/editor/src/index.tsx` | `editor/**`, `protocol`, `runtime`, `three-adapter`, `project-model`, `commands`, `three`, `react`, `react-dom` |
| **play-preview bundle** (`dist/preview/`) | `packages/editor/src/preview/preview-bootstrap.ts` | `editor/src/preview/**` (that directory only), `protocol` (the pure wire-types package — bridge messages; §3), `runtime`, `three-adapter`, `project-model`, `three` |
| **export bundle** (export output) | `packages/exporter/src/export-bootstrap.ts` | `exporter/src/export-bootstrap.ts` (that file only), `runtime`, `three-adapter`, `project-model`, `three` |

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
  else from those packages in the runtime bundles.
- The editor/preview bundles are built by the workspace build script (dev
  context — esbuild is a dev tool there, §7); the export bundle is built
  at export time by the `exporter` (esbuild is its runtime dependency,
  §7). Same pinned versions, same flags family; the differences (entry,
  no-bridge) are recorded in `meta.json` (export.md §6).

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
   counts under the export.md §5.3 pinned option set) applies to **both**
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
| Physics | none | — | explicitly unselected (M2 evaluation — decision 0001 §3) |

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