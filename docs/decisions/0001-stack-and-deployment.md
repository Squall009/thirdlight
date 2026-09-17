# Decision 0001 — Stack and Deployment

Status: **proposed; owner-revised 2026-09-16** (no containerization; game
data root moved to user home; see §5–6); **owner-revised 2026-09-17** (React
added as the M1 editor UI framework; see §3, §9, §10). Scope: M1
implementation stack, package workspace, MCP integration, deployment shape,
remote access. Nothing was installed and no service was deployed in packet 00.
Evidence for every measured/verified claim: `docs/environment.md`.

## 1. Confirmed decisions (from charter v0.1 — restated, not re-decided)

| Decision | Status |
|----------|--------|
| Product name **Thirdlight**; repository `thirdlight` | confirmed |
| First game: short **2.5D side-scrolling platformer** (3D scene; movement on XY, depth along Z; physics dimensionality and library chosen later in the bounded M2 evaluation) | confirmed |
| **Desktop** authoring; desktop gameplay with **keyboard and controller** first (mobile not an acceptance target) | confirmed |
| **Personal self-hosting**; others may clone the repository and host their own instances (trusted personal projects; no hostile-code hosting claim) | confirmed |
| **Backend and coding harness on one server sharing one working copy** (backend owns project files; harness edits code/tests directly) | confirmed |
| **Standalone Web export**: exported games run without the editor backend, MCP, or model service; export targets the web, not exclusively WebGL (WebGPU enhancement on a WebGL 2 baseline) | confirmed |

## 2. Adopted implementation defaults (recommended — not previously explicitly confirmed)

- **TypeScript** as the implementation language across the stack, strict mode.
  Recorded per prompts packet 00 as an *adopted recommended default*; the
  charter lists it as "Recommended default; not explicitly confirmed". The
  owner may override.
- **External harness + MCP before embedded chat** (charter: recommended
  default). No embedded chat in M1.
- **One active authoring session per project** initially (charter: proposed
  scope limit), plus the external harness as a separate non-browser client.
  MCP is a client of the same command services — never a second source of
  truth.
- **WebGPU enhancements with a supported WebGL 2 baseline** (charter
  compatibility policy); feature coverage is proved before any parity claim.

## 3. Proposed minimal stack (pins for packet 04; owner confirmation where marked)

| Item | Proposal | Evidence | Status |
|------|----------|----------|--------|
| Runtime | Node 22 (host: v22.22.1 x64) | measured (environment.md) | proposed — any version change requires owner approval |
| Language | TypeScript, strict | charter recommendation | **confirmed by owner 2026-09-16: TypeScript 5.9.3** (see below) |
| Package manager | npm 9.2.0 (the only installed manager) with npm workspaces | measured; registry reachable | proposed — switching to pnpm/bun etc. would be an install; owner preference needed |
| Backend HTTP | built-in `node:http` + `ws@8.21.3` for the browser session WebSocket | registry-verified | proposed (no web framework) |
| 3D / rendering | `three@0.186.0` + `@types/three@0.186.0`; WebGL 2 renderer path first; `three/webgpu` path only after feature coverage is proved | registry-verified | proposed |
| Build / bundle | `esbuild@0.28.2` (dev) | registry-verified | proposed |
| Tests | `vitest@5.0.1` (dev) | registry-verified | proposed |
| MCP (backend side) | `@modelcontextprotocol/sdk@1.30.0` (node >= 18) | registry-verified | proposed |
| UI framework | **React** for editor panels only: `react@19.3.0`, `react-dom@19.3.0`, `@types/react@19.3.0`, `@types/react-dom@19.3.0`. Three.js viewport/gizmo/picking code stays imperative and framework-free (boundaries in §10) | registry-verified 2026-09-17 | **owner ruling 2026-09-17** — supersedes the original "none for M1" proposal |
| Physics | **none** (deferred to the bounded M2 evaluation) | charter §6; packet 00 instruction | explicitly unselected |

**TypeScript line — CONFIRMED by owner 2026-09-16: 5.9.3.**
Recommendation (accepted): pin the mature classic compiler for M1. Rationale
recorded at recommendation time: the 7.0.2 native (tsgo) port is ~2.5 months
from GA, its speed gain is irrelevant at M1's small-package scale, and
Compiler-API/plugin ecosystem support is still settling. Revisit 7.x as a
cheap upgrade after M1 (both lines satisfy strict mode and host Node 22).
No TypeScript toolchain is installed yet; packet 04 installs the pinned
version.

**No installs in this packet.** The table is a pinning proposal; packet 04
performs the first installation.

## 4. Proposed package workspace (no packages created yet)

npm-workspaces monorepo at the repository root:

- Root: `package.json` (workspaces), `tsconfig.base.json` (strict),
  build/typecheck/test scripts, one lockfile.
- Planned units, created **only when implemented** (charter §5; packet 03):
  `project-model`, `commands`, `workspace`, `runtime`, `three-adapter`,
  `protocol`, `backend`, `editor`, `mcp-adapter`, `exporter`.
- Boundary rules (charter §5; packet 03): public exports only; no
  cross-package internal imports; no hidden global services; runtime bundles
  must not transitively include editor/server/MCP code. Machine-enforced in
  packet 04 (including a negative fixture proof).

## 5. MCP transport to the external harness

- The Thirdlight backend exposes an **MCP server** (tool categories per
  charter §7: bounded project/entity inspection, command submission, session
  listing, play start/stop, bounded diagnostics, screenshot from the selected
  connected browser).
- **MCP is the sanctioned way (charter §7) for the external harness to
  manipulate and observe the editor** through the same command services the
  browser uses. Division of work:
  - **Server side — a Thirdlight deliverable** (packet 11, `mcp-adapter`
    package): the backend embeds an MCP server exposing the charter §7 tool
    categories (bounded project/entity inspection, command submission,
    session listing, play start/stop, bounded diagnostics, screenshot from
    the selected connected browser). It routes into the same application
    services as the UI; it is never a second mutation engine.
  - **Client side — on the harness, a thin connector, not a Thirdlight
    service.** Verified harness fact (environment.md §1): pi 0.85.0 has
    **no built-in MCP client** — its documentation states this explicitly —
    so out of the box pi cannot speak MCP. Two supported connection options,
    to be chosen in packet 11 (owner approval before any install):
    1. A **pi extension acting as MCP client** — the pi-documented mechanism
       ("build an extension that adds MCP support"). Either an npm candidate
       (metadata-verified, not installed: `pi-mcp-adapter@2.34.0`,
       `pi-mcp-extension@1.5.0`) or a small custom extension committed under
       this repo's `.pi/extensions/`.
    2. A **bash/CLI fallback** (the pi README's stated alternative): no
       client install at all — pi calls a small CLI or the backend REST API
       from its bash tool. Coarser (no protocol-level tool discovery) but
       zero harness changes.
- **Proposed transport: streamable HTTP on localhost** — the backend is a
  long-running service, so the client points at
  `http://127.0.0.1:<port>/mcp` with the project-scoped auth token.
  Alternative: stdio, where a client process is spawned per session.
  Final transport and client choice are settled in packet 11 against the
  chosen client's official documentation.
- Net effect: the pi harness **can** interact with the editor through MCP —
  once the thin client is connected. The heavy lifting (MCP server, tools,
  auth, session routing) is project work; the client is a small addition on
  the harness side, and installing anything on the harness is an owner
  decision.
- Session model: one active browser authoring session per project + the
  harness MCP client. Play/screenshot tools target an explicitly selected
  browser session; with no browser connected they return a structured
  session-unavailable error (charter §7).

## 6. Deployment (no containers — owner ruling; nothing deployed)

**Owner ruling (2026-09-16): no Docker/Podman/compose. The harness already
runs inside a Proxmox LXC; nothing in this project is containerized.** This
supersedes the packet 00 two-container proposal (kept in handoff 00 as
history only).

Shape: two long-lived processes inside the same LXC sharing one filesystem:

```text
LXC (Ubuntu 26.04, this environment)
  ├── pi-web (harness, already running; per-user services)
  │     works on the engine repo: /home/dadmin/projects/thirdlight
  └── thirdlight-backend (planned; later a systemd user service)
        workspace root: /home/dadmin/thirdlight/projects/<project-id>/  (owner decision)
```

- Engine source and game project data are separate trees (charter §4): code
  in `/home/dadmin/projects/thirdlight`, per-project authoring data in
  `/home/dadmin/thirdlight/projects/<project-id>/` (created empty, owned by
  `dadmin`). Naming note: the engine repo is `projects/thirdlight`, the data
  root is `thirdlight/projects` — deliberately mirrored, different levels.
- "Backend and harness on one server sharing a working copy" (confirmed
  decision) now holds trivially: same filesystem, no mounts to reconcile.
  The backend API still uses project IDs and paths relative to
  `/home/dadmin/thirdlight/projects`; clients never send absolute paths.
- **History of the data-root decision:** packet 00 first recorded
  `/etc/thirdlight/projects` (owner), which would have required a one-time
  root action (`/etc` is root-owned; sudo is password-gated). Owner ruling
  2026-09-16, second revision: moved to the user home to avoid the
  permission fight — the `/etc` path is withdrawn; no root action needed.
- Exported game output is later served by a plain static HTTP server, not
  the editor backend.
- No services are deployed in this packet.

## 7. Remote access and secure context

- Authoring access: the user's **desktop browser** over the LAN to the
  backend's web UI. pi-web's documented deployment (reverse proxy with
  canonical trailing-slash prefixes, allowed-hosts configuration) is the
  reference pattern for how the harness is already exposed; the Thirdlight
  backend needs the same treatment (proxy/TLS choice settled in packet 13).
- **WebGPU requires a secure context** (HTTPS or localhost). On plain-HTTP
  LAN access, WebGPU features must be treated as unavailable and the WebGL 2
  baseline must be fully sufficient for M1. TLS termination at the reverse
  proxy is therefore a later requirement, not an M1 blocker.
- Authenticated, project-scoped access is required even for the private
  deployment (charter §7); token/origin mechanics are packet 09 scope.

## 8. Open items / unknowns carried forward

1. (Resolved 2026-09-16: owner confirmed TypeScript **5.9.3** for M1; revisit
   7.x after M1. No TypeScript toolchain is installed anywhere on this
   machine yet — verified: no global package, no `tsc` on PATH.)
2. (Resolved 2026-09-16, second owner ruling: game data root moved to
   `/home/dadmin/thirdlight/projects/`; `/etc/thirdlight` withdrawn; no root
   action needed — directory created, owner `dadmin`.)
3. Package manager: npm 9.2.0 is the only installed one (and is older than
   the npm bundled with Node 22.x); any switch or upgrade is an owner
   decision.
4. MCP client side for pi (extension package vs in-repo extension vs
   bash/CLI fallback) and transport — selection in packet 11.
5. Reference desktop/browser for the performance policy (charter §8) —
   recorded when performance is first measured, not now.
6. LAN topology / ports reachable from the user's desktop browser — unknown.
7. Git (resolved 2026-09-16): owner confirmed `git init` and a **public**
   GitHub remote for the engine repository; initial commit + push performed
   in the packet 00 post-handoff work. Game project data under
   `/home/dadmin/thirdlight/projects/` stays outside this repository (it is
   not engine source).

## 9. Rejected / deliberately not chosen (recorded so future sessions don't repeat them)

- No physics engine, no advanced graphics/compute libraries, no web framework:
  deferred to bounded evaluations when their packets become concrete (charter
  §11; packet 00 instruction). (The former "no UI framework" clause was
  superseded for editor UI by the owner ruling 2026-09-17 — see §10.)
- No pnpm/bun install to "modernize" the package manager: npm is the only
  manager present; unrequested changes are forbidden.
- No server-side GPU/browser assumptions; no headless browser automation in
  M1 (charter §7).
- Containerized deployment (Docker/Podman, shared-mount containers): rejected
  by owner ruling 2026-09-16 — deployment is process-level inside the LXC.

## 10. UI framework selection — owner ruling 2026-09-17 (supersedes "no UI framework")

**Ruling (recorded 2026-09-17):** React is the M1 editor UI framework.
Pinned per the registry-verification standard used for all stack items:
`react@19.3.0`, `react-dom@19.3.0`, `@types/react@19.3.0`,
`@types/react-dom@19.3.0` (all verified against the npm registry
2026-09-17). Charter §11 makes the UI framework a focused selection when the
editor task becomes concrete; the owner elected to make that selection by
direct ruling before packet 10, so no vanilla-DOM editor code exists that a
later framework addition would have to replace.

**Recorded rationale:** the editor UI roadmap extends well beyond M1's
minimal panels (timeline, node-graph tooling, many panels/forms). React's
declarative rendering, composition model, and mature component ecosystem
(e.g., react-flow for node graphs, dnd-kit for drag & drop) materially
reduce roadmap cost at that scale. At M1's minimal panel count the vanilla
DOM approach was defensible; the decision was made on the roadmap, not the
M1 scope.

**Boundaries (binding for all editor work):**

- React owns the DOM panels: hierarchy/entity list, transform inspector,
  toolbars, connection/save status, play controls (packet 10 scope).
- The three.js scene graph, camera controls, gizmos, picking, and the play
  preview stay **imperative three.js code, outside React rendering**. React
  never instantiates or mutates Object3Ds; scene mutation flows only through
  editing commands (no duplicate scene mutation paths).
- Browser state remains a projection of backend state; commands are the only
  mutation path (charter §6). Panels re-render from state; they do not cache
  authoritative state in DOM nodes or module variables.
- Build: esbuild handles TSX natively; this ruling adds no new build tool
  and no web framework.
- Scope guard: this ruling selects a framework; it does **not** expand the
  editor UI beyond packet 10's scope ("no decorative dashboard, prefab
  browser, graph editor, or unrelated panels").

**Superseded:** the §3 row "UI framework — none for M1" and the §9 item
"no UI framework" as they applied to editor UI. Backend web framework and
physics remain unselected/rejected as recorded.