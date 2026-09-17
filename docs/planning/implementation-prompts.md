# Thirdlight — Implementation Prompts

Version 0.1.1 · 2026-09-17

Revision 2026-09-17: owner ruling added React to the M1 editor UI stack
(decision 0001 §10). Packets 04 and 10 clarified accordingly; all other
packets unchanged.

## Start here

Create or select a repository named `thirdlight` in the workspace your coding harness can access. Add the existing charter as `docs/architecture/charter.md` and this file as `docs/planning/implementation-prompts.md`. These are suggested repository paths, not files already installed on your server.

Run Prompt 00 first. It records the actual environment and establishes the project instructions. Then run ONE numbered prompt per task/session. Do not paste the entire sequence into a model and ask it to continue automatically. Each prompt includes the files the model needs; this whole document does not belong in every context window.

This pack is detailed through M1: create, edit, undo, save, reopen, play, export, and edit through MCP. Later milestones receive planning prompts rather than speculative implementation assignments. The platformer follows after this foundation passes review.

TypeScript is the recommended working default. Prompt 00 records it as an adopted implementation default unless the project owner chooses otherwise; it must not falsely label it an earlier explicit user decision.

### Review gates

| Gate | Run through | Bring back for architectural review |
|---|---|---|
| A | 00–03 | Environment report, project model, transaction/persistence and runtime/session/export contracts |
| B | 04–07 | Relevant implementation diff, persistence/recovery tests, dependency check results |
| C | 08–12 | Runtime/UI/MCP/export diff, screenshots, integration evidence |
| D | 13 | Full M1 acceptance report and unresolved limitations |

At each gate, stop dependent implementation until the findings are resolved. A contract change during later work reopens the relevant review gate. This is an architectural review workflow, not a request for permission before every reversible edit.

## Persistent harness instruction

Use this as the project instruction, merging with existing instructions rather than overwriting them. Keep it in `AGENTS.md` if your harness reads that filename; otherwise use its equivalent project-rules mechanism.

```text
You are implementing Thirdlight, a self-hosted browser game editor built on
three.js. Work on exactly the assigned packet, not the entire product.

The backend owns project state. The browser and MCP use the same editing
commands. The coding harness shares the backend's filesystem workspace.
Exported games must run without the editor backend, MCP, or model service.

Read docs/STATUS.md, the assigned packet, and only the listed contracts and
relevant source/tests. Search selectively. Do not ingest the entire repository.
If you need more context, inspect public interfaces before implementations.

Respect module ownership and public exports. No cross-package internal imports,
hidden global services, or duplicate scene mutation paths. No runtime dependency
on editor/server/MCP code. Use strict TypeScript under the adopted stack decision.

Implement the smallest complete behavior that meets the packet. Do not add
unrequested frameworks, future game systems, or placeholder implementations
that pretend to satisfy acceptance criteria.

An accepted contract is binding. If it cannot satisfy the task, document the
specific issue and proposed contract diff; do not silently change it or build
a workaround that changes its meaning. Complete independent safe work first.

Preserve unrelated and uncommitted user changes. Do not reset the repository,
delete projects, push, publish, or install services outside the task scope.
Do not expose credentials in logs, browser bundles, fixtures, or handoffs.

Use the lockfile and recorded toolchain. Consult official documentation for
version-sensitive APIs. Record unavailable tools/network access; do not invent
versions, test results, screenshots, performance figures, or review approvals.

Test observable failure modes and module boundaries. For visual behavior,
verify in a browser when available; otherwise explicitly mark visual checks
unverified. Mocks alone do not establish integration success.

Finish with docs/handoffs/<packet-id>.md containing: outcome, changed files,
commands run and results, acceptance criteria passed/failed/unverified,
limitations, contract-change requests, and exact next packet. Update only
the relevant progress row in docs/STATUS.md. Do not automatically start it.

Keep the handoff concise, preferably under 1,000 words. Include a commit ID
if a commit was actually made, otherwise a scoped diff summary. Never claim
that another reviewer approved the work.
```

## 00 — Repository intake and environment

```text
Initialize Thirdlight's planning workspace. Do not implement the editor yet.

Read docs/architecture/charter.md and inspect the repository's existing
instructions/status. If the charter is absent, report the missing input.

Create or update:
- AGENTS.md using the supplied persistent harness instruction.
- docs/STATUS.md with packet IDs 00–13 and gates A–D; start unrun tasks as pending.
- docs/environment.md.
- docs/decisions/0001-stack-and-deployment.md.

Determine actual server OS/CPU architecture, available Node/package-manager
and container tools, workspace paths accessible inside this harness, and
existing repository structure. Do not infer the host mount path from a
container path. Mark inaccessible host information as unknown. Do not print
environment variables or secrets wholesale.

Record the confirmed decisions: Thirdlight name; 2.5D side-scrolling first game;
desktop authoring and keyboard/controller gameplay; personal self-hosting;
backend and harness on one server sharing a working copy; standalone Web export.

Adopt TypeScript as the recommended implementation default, recording that it
was recommended rather than previously explicitly confirmed. Propose a minimal
Node backend, browser UI, and package workspace. Select actual compatible
toolchain/dependency versions using official sources and the available host;
record evidence and uncertainties. Do not install a dependency stack yet.
Avoid selecting physics or advanced graphics libraries at this stage.

Default to one active authoring session per project, plus the external harness.
State how the selected MCP transport can connect to that harness; verify the
harness's documented capability if accessible rather than guessing it.

Propose deployment configuration for two containers with a shared project mount.
No services are deployed in this packet. Document remote desktop-browser access
and the later need for an appropriate secure context for WebGPU features.

Acceptance: confirmed facts, proposed defaults, and unknowns are distinguishable;
existing files are preserved; no implementation has begun. Finish with handoff 00.
```

## 01 — Project data contract

```text
Define Thirdlight's minimal project model. Documentation and JSON fixtures only.
Read AGENTS.md, docs/STATUS.md, docs/architecture/charter.md, and decision 0001.
May edit docs/contracts/project-model.md and fixtures/project-model/**.

Specify one project manifest and one active scene for M1. Use stable opaque
string IDs, explicit schemaVersion, project-relative references, and a registry
of known component types. Authoring values must be JSON serializable and finite.
Do not persist Object3D instances, functions, filesystem absolute paths, or
transient selection/play state. Distinguish schema versions, engine versions,
authoring revisions, and later runtime snapshot identifiers.

Use Y-up, right-handed world coordinates; define units as meters. Persist local
position (3 numbers), rotation quaternion (4 numbers), and scale (3 numbers).
Describe validation/normalization, parent hierarchy, cycle rejection, and
deletion semantics. The later platformer moves on XY with depth along Z.
Specify default camera orientation consistent with this convention.

M1 needs Transform, a box primitive with a simple material, and a camera.
Define their exact serialized fields, defaults, references, and validation.
Do not design a full ECS, physics schema, prefab inheritance, or shader graph.
Unknown component types and future schema versions must produce actionable
errors without rewriting or discarding the original document.

Create a tiny valid project/scene and focused invalid fixtures for duplicate
IDs, a cycle, a missing reference, invalid numbers/rotation, and unsupported
versions. JSON cannot encode NaN; specify a runtime validation case separately.
Describe migration entry points without implementing hypothetical migrations.

Acceptance: another model can implement a validator/serializer without
inventing fields or coordinate conventions. Finish with handoff 01.
```

## 02 — Commands, persistence, and conflict contract

```text
Specify authoring correctness before writing backend code.
Read project-model.md, charter sections 4–6, and the environment report.
May edit docs/contracts/commands.md and docs/contracts/workspace.md, plus
fixtures/commands/**. Do not change project-model.md silently.

Define exact request/result schemas for createEntity, setTransform, deleteEntity,
undo, redo, and bounded project/entity queries. Every mutation includes projectId,
expectedRevision, and requestId. Define structured errors and change/inverse data.
Creation IDs must remain stable on retries. Define deletion of children/references.

Use a project-level monotonically increasing revision and serialized mutations.
An identical retried request returns its recorded result; a reused requestId with
different content fails. Define ordering of deduplication versus revision checks,
how retry records survive restart, and their documented retention bounds.
Failed commands leave no partial changes. Undo/redo are new revisions; fresh
edits invalidate redo. Explicitly handle mixed human/agent editing history.

Choose a deliberately small M1 durability scheme: manifest/settings are immutable
during M1 editing; scene data, revision, and required retry metadata live in ONE
atomic authoring-state envelope. Do not simulate multi-file atomicity with several
renames. Document that future multi-scene transactions require a new persistence
contract. Specify write-temp/flush/replace/directory-flush behavior appropriate to
the supported OS, restart recovery, error outcomes, and acknowledgement timing.
Distinguish process-crash guarantees from power-loss guarantees.

The backend is the only supported writer of active authoring state. Harness code
edits remain direct. For authoring maintenance, define a close/release-workspace
procedure, external edit, validate, and reopen. Detect unexpected external edits,
retain recoverable bytes, and pause writes; do not claim a file watcher or a hash
check can prevent all races with arbitrary bypassing writers. Define second-backend
ownership rejection and stale-owner recovery without unsafe automatic takeover.

Give examples for retry after lost acknowledgement, stale revision, invalid
transaction, crash before/after replacement, and unexpected external modification.
Acceptance: outcomes and supported guarantees are unambiguous. Handoff 02.
```

## 03 — Runtime, session, export, and dependency contracts

```text
Finish the M1 architecture contracts; no production implementation.
Read project-model.md, commands.md, workspace.md, and decision 0001.
May edit docs/contracts/{runtime,sessions,export,dependencies}.md and
docs/planning/m1-acceptance.md. Propose changes to earlier contracts separately.

Runtime: define instantiate/start/stop/dispose, immutable snapshot input, separate
mutable simulation state, transform ownership, fixed steps with bounded catch-up,
render interpolation policy, and structured diagnostics. Runtime has no filesystem,
backend, editor, or MCP dependency. M1 may use a built-in moving-box demonstration;
arbitrary user-script loading is deferred until an execution boundary is reviewed.

Sessions: define exact browser/backend request/event shapes, connection and session
IDs, authoring/play revisions, snapshot resync, gesture preview/commit, and reconnect
after a dropped acknowledgement. Define bounded logs and errors. The backend routes
play/screenshot requests to an explicitly selected browser; no browser means a
structured unavailable result. Preview frames must not receive backend credentials.
Specify a separate-origin preview with an exact-origin/source checked message bridge,
session handshake, and a narrow allowlist of messages; use authenticated authoring
access and explain development/deployment origin configuration.

Export: same runtime as play mode; immutable snapshot and dependency versions;
static files with relative paths; no authoring URLs, credentials, MCP, Node-only
imports, or service dependency. Define validation failures and reproducibility
scope. One small supported scene first, not a general asset build system.

Dependencies: map package public exports and allowed import edges. Suggested
initial units: project-model, commands, workspace, runtime, three-adapter, protocol,
backend, editor, mcp-adapter, exporter. Only create packages when implemented.
Define enforceable boundary checks and a narrow module registration mechanism.

Write the exact M1 acceptance scenario linking each requirement to a future check.
Document which later tools (input simulation, physics, graphs) are not M1 promises.
Finish handoff 03 and mark Gate A ready for review, not approved. Stop here.
```

## 04 — Minimal toolchain and dependency checks

```text
Prerequisite: Gate A review is recorded as accepted in docs/STATUS.md.
Read decision 0001, dependencies.md, and M1 acceptance criteria.
Implement only the minimal workspace/toolchain: package manager lockfile, pinned
toolchain policy, strict TypeScript (including TSX — esbuild TSX loader for the
`editor` package's React UI, decision 0001 §10), build/typecheck/test commands,
and import boundary checks. Create package directories only as necessary, not empty systems.
Use selected versions; if unavailable/incompatible, report a concrete decision
change instead of substituting silently. Do not implement product features.

Document clean install and verification commands. Prove a forbidden runtime-to-
editor dependency fails the boundary check using a temporary negative fixture,
then remove the fixture. Do not declare CI passed unless it ran. Handoff 04.
```

## 05 — Project model implementation

```text
Read project-model.md and its fixtures, dependencies.md, and packet 04 handoff.
Implement the model package's public types, runtime validation, serializer/parser,
and minimal component definitions. May edit its package, tests, and necessary
workspace registration. No renderer, UI, server, or command implementation.

Contracts are authoritative. Validate untrusted parsed data at the boundary;
TypeScript types alone are insufficient. Make serialized output stable for diffs.
Verify valid roundtrip, each agreed invalid fixture, hierarchy/reference rules,
and unsupported version handling without destructive rewrite. Handoff 05.
```

## 06 — Pure commands and history

```text
Read commands.md, project-model public exports, and workspace.md for ownership.
Implement only pure command validation/application and history semantics in the
commands package. No filesystem, transport, UI, or three.js dependencies.
The workspace will own serialization of requests, durable revision/dedup state,
and persistence; do not create a second authority inside command helpers.

Cover create, transform edit, delete, undo, redo, inverse generation, and atomic
batch behavior if and only if the contract includes it. Prove invalid edits leave
inputs unchanged, inverses restore the intended values, redo invalidation follows
the contract, and hierarchy integrity survives deletion/undo. Handoff 06.
```

## 07 — Durable workspace service

```text
Read workspace.md, commands.md, model/command public exports, and environment.md.
Implement the workspace package on the real filesystem behind its public service
interface. No browser UI or MCP yet. Implement ownership, open/close/release,
revision serialization, durable retry records, atomic state persistence, recovery,
and unexpected external-change handling exactly as specified.

Resolve project IDs inside the configured workspace root; reject traversal and
symlink escapes under the supported policy. Never accept arbitrary absolute paths
from a browser/MCP request. Keep source edits and derived outputs separate.

Use temporary directories and controlled subprocess termination/fault injection
for meaningful persistence tests: concurrent stale mutations, retry after lost
acknowledgement and restart, failure before replacement, recovery after replacement,
invalid external file, and a second backend claiming the project. Do not kill real
services or alter user projects. State tested crash guarantees honestly.

Finish handoff 07 and mark Gate B ready for review. Stop dependent implementation.
```

## 08 — Runtime and three.js adapter

```text
Prerequisite: Gate B accepted. Read runtime.md, project-model.md, dependencies.md.
Implement runtime core and a small three.js adapter as distinct modules. Runtime
core must not import three.js; the adapter owns Object3D/material/GPU lifetimes.
Scope: agreed primitive, camera, simple material, transform synchronization, fixed
update loop, and built-in demonstration behavior. No physics or arbitrary scripts.

Instantiate independent mutable runtime state from an authoring snapshot. Dispose
all owned resources/listeners and prevent duplicate loops after start/stop cycles.
Use one renderer path consistent with the accepted stack; do not promise WebGPU/
WebGL feature equivalence without testing. Report backend selection in diagnostics.

Verify simulation leaves the source snapshot unchanged and disposal is repeatable.
Use a tiny development fixture to visually verify camera/axes and motion when a
browser is available. Record actual browser/backend and unverified targets.
Do not build the full editor in this packet. Handoff 08.
```

## 09 — Backend API and live session transport

```text
Read sessions.md, commands.md, workspace service exports, and dependencies.md.
Implement protocol types/validation and backend adapters for project queries,
commands, notifications, resync, and browser session registration. Transport code
delegates all persistent changes to the workspace service; never mutates files
independently. Implement the agreed authentication/origin policy and bounded errors.

Include an explicit registered-session requirement for live browser actions.
Do not implement headless browser hosting or assume GPU access on the server.
Verify stale requests, duplicate retries, disconnect/resync, invalid session IDs,
unauthorized access, and malformed messages with integration tests against the
actual backend and a disposable workspace. Handoff 09.
```

## 10 — Minimal visual editor and isolated play

```text
Read sessions.md, runtime.md, commands.md, protocol exports, and m1-acceptance.md.
Implement a practical minimal editor: hierarchy, scene viewport, selection,
transform inspector/gizmo, create/delete box, undo/redo, save status, connection
status, and play/stop. Use the approved UI stack: React for the panels
(decision 0001 §10); the three.js viewport, gizmos, and picking stay imperative
and framework-free. No decorative dashboard, prefab
browser, graph editor, or unrelated panels.

Browser state is a projection of backend state. Gizmo gestures preview locally
and commit as one undoable command. Conflict/reconnect handling must restore a
valid projection and explain failed edits rather than silently losing them.
Do not write to browser storage as the authoritative project database.

Play uses the agreed separate-origin preview and restricted message bridge. Verify
preview code has no privileged authoring token. Play motion must not change the
authoring scene. Identify the snapshot revision displayed in the play session.

Verify visually when possible: edit, undo, redo, reopen, disconnect/reconnect, play,
stop, and repeated play disposal. Capture screenshots and browser errors. If no
browser is available, mark the visual checks unverified and provide precise manual
steps; do not fabricate approval. Handoff 10.
```

## 11 — MCP adapter for the external harness

```text
Read the recorded harness transport decision, sessions.md, commands.md, protocol
exports, and backend API public surface. Implement the MCP adapter using the
supported SDK/transport and official version-matched documentation. Do not invent
a custom JSON protocol and label it MCP. Do not implement embedded chat.

Expose a minimal set: bounded project/entity inspection, command submission,
session listing, play start/stop, bounded diagnostics, and screenshot capture from
a selected connected browser. Implement through existing services. If the editor
needs a missing screenshot endpoint, implement a narrowly scoped session-contract
adapter; contract changes require review. No general eval/shell tool.

Responses include relevant revisions/session IDs, meaningful errors, and bounded
payloads. Document harness connection configuration without real credentials.
Use the actual MCP client/harness if available to create a box, change its transform,
and observe the result in the browser. Prove stale mutations and no-browser visual
requests fail as specified. Unit tests alone do not establish end-to-end MCP success.
Handoff 11.
```

## 12 — Standalone export

```text
Read export.md, runtime/adapter public exports, project-model.md, and dependencies.md.
Implement export of an immutable valid M1 scene snapshot using the SAME runtime
used by play mode. Produce static browser files with relative asset references and
recorded engine/build metadata. Do not build a separate gameplay implementation.

Validate references and supported components before writing a successful artifact.
Exclude editor/backend/MCP packages, credentials, source-workspace paths, and calls
to authoring services. Do not imply opening index.html via file:// is supported;
document serving output through a plain static HTTP server.

Verify exported output through an independent static server with the editor backend
stopped or unreachable. Inspect browser network/errors and bundle dependencies.
Verify the agreed reproducibility scope using repeated builds of the same snapshot.
Do not publish to the internet. Handoff 12; mark Gate C ready for review.
```

## 13 — M1 integrated acceptance and local deployment

```text
Prerequisite: Gate C accepted. Read m1-acceptance.md, environment.md, deployment
decision, and handoffs 07–12. Review source selectively as failures require.

Exercise the whole loop on a disposable project: create box in browser, edit
transform, undo/redo, close/reopen, restart backend, run isolated play, perform
an MCP edit, test a stale concurrent edit, export, and run output without backend.
Also verify expected external-change and disconnected-browser behavior.

Write docs/acceptance/m1-report.md with actual commands, versions, browser/render
backend, screenshots, pass/fail/unverified status, and unresolved issues. Do not
substitute a mocked test run for this scenario. Fix bounded implementation defects;
propose contract changes separately. Avoid opportunistic refactors.

Provide a minimal self-host deployment configuration and docs for the actual server
architecture, shared mount, configured origins, authentication, startup/shutdown,
backup/restore, and harness MCP connection. Do not deploy to the user's host without
an applicable task authorization. Do not mount the container daemon socket merely
to run builds. Preserve the existing harness; document integration adjustments.

Container files can be verified locally where tools permit. Clearly distinguish
configuration supplied from deployment actually performed. No public hosting.

Finish handoff 13 and mark Gate D ready for review. M1 is accepted only after its
evidence is reviewed; list remaining failures and do not automatically start M2.
```

## Repair prompt — use after review findings

```text
Address only the supplied Thirdlight review findings below.

Read AGENTS.md, the original task packet, its relevant contracts, and the affected
implementation/tests. For each finding, identify the cause, make the smallest
compatible fix, and run a check that exercises the failure. Do not change acceptance
criteria to hide a failure. If the finding needs a contract change, propose that
diff separately and stop dependent edits until reviewed.

Update the original handoff with finding IDs, changes, evidence, and unresolved
items. Preserve unrelated work. Do not start the next packet.

REVIEW FINDINGS:
[Paste the review findings here.]
```

## Architectural review prompt — bring back with each gate

```text
Review Thirdlight Gate [A/B/C/D]. Do not implement new features.

Attached: current charter, relevant contracts, gate handoffs, implementation diff
where applicable, and actual test/browser evidence. The implementation is by a
local coding model; do not assume its completion claims are correct.

Check scope compliance, public boundaries, state ownership, revision/retry behavior,
durability/recovery, browser/runtime isolation, export independence, and evidence
quality as relevant to this gate. Identify critical missing context explicitly.

Return prioritized findings with affected files, concrete failure scenarios, and
the smallest repair task. Distinguish blockers from later improvements. State
accept / accept with bounded follow-ups / changes required, and the limits of
what the supplied evidence establishes. Do not claim to have executed tests if
you only inspected their reported output.
```

## After M1 — next milestone planning prompts

These are intentionally planning-only. Run them individually after the preceding milestone is reviewed. They prevent early models from inventing the entire future engine.

### M2: assets, basic prefabs, input, and physics

```text
Plan Thirdlight M2 against the accepted M1 repository. Read the charter, public
module contracts, and M1 acceptance report; inspect implementations selectively.
Do not implement features yet.

Create bounded contracts/task packets for: stable asset identities and GLB import/
preview/reimport; basic prefab instantiation with explicitly limited override
semantics; declared gameplay properties and reviewed script execution boundaries;
keyboard/controller actions; a chosen physics adapter; and a 2.5D controller.

Evaluate physics choices against actual browser/build compatibility, CPU cost,
character-controller requirements, license, and maintainability. Specify movement
plane, collision dimensionality, fixed-step synchronization, grounding, slopes,
jump behavior, and camera conventions. Avoid unbounded nested-prefab semantics.

For each packet provide read set, allowed edits, public interfaces, dependencies,
failure cases, acceptance evidence, and review gate. Keep tasks small; split any
task requiring simultaneous redesign of multiple systems. Bring the plan back for
architectural review before implementation.
```

### M3: one complete short platformer

```text
Plan Thirdlight M3 after M2 acceptance. Specify one short 2.5D level that can be
completed from a start screen to a clear goal. Include camera, hazards, respawn/
checkpoint, basic HUD, audio, and enough content to test editor workflows.
Use accepted modules; identify missing APIs instead of bypassing them in game code.
Provide small implementation packets and browser/export playthrough acceptance.
Do not add Metroidvania progression, inventories, quests, or multiplayer yet.
Planning only; return for review.
```

### M4: reusable template and reliability

```text
Plan Thirdlight M4 after the sample platformer is accepted. Specify a reusable
platformer template and independent game project with pinned engine dependencies.
Distinguish editor layout visibility from runtime module inclusion. Add measured
reference-device budgets, recovery/backup checks, and template/export validation.
Produce bounded packets based on observed limitations, not speculative abstractions.
Planning only; return for review before adding advanced rendering or RPG systems.
```

## What to send the architect

Send each gate's handoffs and relevant contracts, plus the diff or repository access and actual evidence. A short model-written success summary is insufficient for code review. Omit dependency directories, generated caches, secrets, full unrelated logs, and large original assets unless a specific issue requires them. Keep rejected decisions documented so future local-model sessions do not repeat them.
