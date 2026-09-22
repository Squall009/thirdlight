# M4 — Reusable platformer and release reliability

**DRAFT · planning only · architectural review pending.** Owner request: M3 is
complete; write M4 packets and the final owner review checklist. This request
allows planning, not implementation, contract promotion, installation, deployment,
publishing, or a new milestone. No M4 performance result or approval is claimed.

Deliverables: [packets 63–82](m4-packets.md), [acceptance matrix](m4-acceptance.md),
[final owner checklist](../acceptance/m4-owner-checklist.md),
[planning handoff](../handoffs/m4-planning.md).

## 1. Outcome and scope

A person can create a new platformer from a versioned template, customize it
through the editor and MCP, keep it as an independent game project with a pinned
engine/toolchain, back it up and restore it, and build a standalone web game.
The new project must visibly work in both production hosts, not merely pass a
Node simulation trace. Reliability and performance claims have reproducible
failure tests and measurements on a named desktop.

This implements the M4 prompt in `implementation-prompts.md` and charter §§3–5,
8–9. Retain the accepted M3 gameplay limits: one scene/player/checkpoint/goal,
rigid-node animation, bounded WAV cues, static collision geometry and the existing
controller. No new genre mechanics, linked/nested prefabs, editor docking system,
plugin marketplace, automatic engine upgrades, online backup service, cloud sync,
multiplayer, mobile acceptance, WebGPU/advanced rendering, or RPG systems.

### Baseline honesty

Plan against the **current working tree**, including the uncommitted M2/M3 work,
not the old M1 HEAD. Do not reset, stash away, or relabel it. The owner says M3 is
complete; the recorded Gate P verdict is in-container acceptance, not a physical
playthrough or owner contract approval. Preserve all historical evidence labels.
`handoffs/m3-owner-review.md` is an early-progress brief, not the current status;
use `handoffs/gate-p.md` and `acceptance/m3-report.md` for the completion record.

The following observed limitations are M4 work, not homework that the owner must
somehow make pass without implementation:

| Observation / source | M4 disposition and owner |
|---|---|
| Gate O F5 / Gate P F2: model entities become empty Groups in the shared scene adapter; isolated animation tests do not prove delivered animation | 64 contracts the attach/lifetime seam; 69 implements; 70 wires both hosts; 81 requires rendered poses. This is a product gap, not just missing hardware. |
| Gate P F1/F3: rendered player motion and real browser preview not demonstrated | 63 reproduces with actual production hosts; 70 closes delivery defects; 81 captures browser traversal in both hosts. A static canvas plus a Node trace is insufficient. |
| Gate P F4 / B17: no two independent decoration prefab copies in the sample | 72 template recipe and 76 independent project include two copies; 81 proves edit independence. |
| Gate O F6: editor settings initialized from defaults because no query supplies actual values | 64 specifies a bounded settings read; 71 implements through the existing query path and tests reconnect. |
| M3 report P2-B: queryProject summary absent from served query | 63 reproduces; 71 fulfills the accepted summary, with HTTP/MCP parity. Do not remove the promised fields to pass. |
| CC-55-3 is described as missing behavior linking in Gate O, but as HUD wording in Gate P/report | 63 reconciles against packet 55/source and creates separate IDs. Built-in-only M4 template is the proposed scope; source-bearing delivered games must fail clearly, not silently drop behavior. Any narrowing of accepted export promises needs explicit Gate Q disposition. Behavior linking is not implicitly implemented here. |
| M3 report/STATUS carry stale resolved items; K-3 export-name confirmation still pending | 63 produces a current disposition ledger, with links to actual resolutions. Preserve old records; 82 gives the owner a current index. K-3 is an owner decision, not a model approval. |
| Deployment §5 allows a live copy/ownership restore contrary to workspace §15 | 67 defines a single consistent runbook; 77 tests it; 82 replaces conflicting deployment instructions. Live file-by-file copy is not a valid complete backup. |
| Workspace public API lacks template creation; packages are private workspace source exports; exporter relies on engineRoot | 65/66 define bounded initialization and a portable engine distribution before 72/75. A directory symlink into this checkout is not independence. |
| Headless Chrome/SwiftShader exists; no physical controller/audio/hardware GPU evidence | Execute available real-browser tests; record unavailable physical checks in the owner checklist. Software-renderer timings never establish desktop budgets. |

63 must verify this ledger; planning inspection is not a fresh execution result.

## 2. Proposed design boundaries (names provisional until Gate Q)

### 2.1 Template versus project versus export — 65, 72–74

Ship **one versioned built-in platformer template**, derived from Beacon Reach's
supported command recipe. It contains starter assets with provenance, copied
material presets, instructions, module requirements, and a simple panel-visibility
preset. It is data plus a bounded recipe, not downloaded executable scaffolding.
No arbitrary template scripts, URLs, postinstall hooks, or general template engine.

A new project has a distinct project identity; entity/asset IDs may be reused only
where project-scoped, with every reference resolving inside the destination.
Project title/objective are editable after creation. Copy bytes, do not hardlink
mutable state. Later edits to a project or template must not affect another copy. Test removal
or replacement of the installed template after creation: existing projects still
reopen/build unchanged; new creations record the replacement's identity.

Workspace owns initialization, just as it owns existing create/migrate operators.
The contract must specify a staged, bounded, resumable operation, destination
reservation and final publication. Replay starter edits through the **same command
engine**, not a parallel JSON mutator. A partially initialized destination is not
an ordinary editable project. Only a complete validated envelope and verified
source closure may be advertised as ready. Freeze revision/retry/history rules,
request identity and crash phases in 65; do not casually call initialization one
undoable user edit. Existing projects are never overwritten or upgraded on open.

Browser creation and MCP creation use the same backend service, with the accepted
project-lifecycle authorization rules. Do not give a project-scoped MCP token global
admin privileges. 73 specifies/implements an explicit admin-scoped creation path;
ordinary editing retains project-scoped credentials.

### 2.2 Panel visibility is not module inclusion — 65, 74

Use a fixed, versioned list of existing panel IDs, visible/hidden toggles and a
Reset Layout action. No drag/dock framework. The template provides initial layout
preferences; user overrides are disposable browser-local preferences, never an
authoring envelope field, scene revision, runtime option or build input. Unknown
or corrupt preferences reset safely. Hiding a panel must not delete components,
disable simulation, remove assets or change the emitted runtime closure.

Required modules derive from declared template/game requirements **and referenced
content**, including transitive dependencies. A required module cannot be disabled
by layout. Resolve a finite approved registry, reject unknown/missing/incompatible
requirements and cycles before publication/build. Do not add arbitrary dynamic
module loading or promise automatic bundle pruning. With one supported platformer
profile, it is acceptable for its required set to be fixed and conservative, but
it must be validated and explained, not inferred from which panels are visible.
72 owns the pure requirement resolver; 73-B wires it into ordinary Play/export
capture as well as template creation, and 75 reuses that same public path for
independent builds. Validation repeats after subsequent authoring edits, not just
once at initialization.

### 2.3 Independent game and exact engine pin — 66, 75–76

Proposed minimum: a **local, integrity-indexed engine kit** vendored into a separate
game directory, using the existing npm-workspaces toolchain internally. Avoid a
registry release or a speculative SDK rewrite. The kit contains an allowlisted
immutable engine source/build-tool set, the exact engine dependency lockfile,
required contract/scan data, notices and an identity record. It contains no user
projects, credentials, node_modules, caches, live ownership files or session data.
The game owns its authoritative project sources, source assets, template provenance,
engine pin and documented build entry; the engine kit is replaceable only through
an explicit future upgrade procedure. Game source edits do not modify the kit.

66 must freeze the exact tree, package scripts/public CLI, identity/digest inputs,
lockfile authority and npm working directory. Proposed pin = actual engine commit
when available **plus** a digest of the kit file inventory and lockfile; a commit
alone cannot identify this dirty working tree. No invented release tag/version.
A source digest is an artifact identity, not a claim that uncommitted work was
reviewed. A kit carrying private/UNLICENSED sources is for this owner's local use;
public redistribution needs a separate licensing decision.

The kit's development/build environment may contain authoring tools. The exported
**browser graph must still contain no backend/editor/MCP/Node dependencies**.
Packaged export invokes public exporter/workspace APIs via a reviewed Node tool;
it may not import exporter internals, copy its algorithms, or depend on the original
checkout's absolute engineRoot. Build twice outside the monorepo, with its paths
unavailable, resolving only the kit and its pinned installed dependencies. Initial
`npm ci` may require the registry; offline *gameplay* and offline *source integrity
verification* are separate claims from an offline clean dependency install.

If the source-kit approach cannot preserve the accepted scanner/build paths, 66
must propose the exact path-normalization/public-entry diff and fixture before Q.
Do not waive scans or silently switch to mutable `file:../thirdlight` dependencies.

### 2.4 Rendering and truthful delivery — 64, 69–71

Reuse the existing visual resource store, injected GLTFLoader port, instance owner
and role controller. Add only the public scene-attachment/lifetime seam needed by
the production adapter. Bytes are captured/digest-verified; loaders get no editor
credentials or arbitrary URLs. Each entity has independent animation state; the
shared resource owner refcounts shared geometry/materials. Late async completions
after stop/reimport/cancel cannot attach to another run. There is still one host
update loop and one physics/camera writer. Animation must not move collision roots.

Both delivery wrappers and the authoring viewport use this same attachment path.
70-B owns viewport media loading/reimport/disposal integration; it does not run a
second gameplay simulation in the editor. Pin old Play to old bytes during an
authoring reimport; a new Play uses new bytes. Corrupt/missing required media fails
visibly; policy-denied audio remains a playable silent mode. Re-measure exact
loader/content scan exceptions and reopen their gate if needed—no wildcard bypass.

### 2.5 Recovery, backup and diagnostics — 67, 77–78

Keep workspace §15's operator procedure: release the project or stop its own
backend, copy manifest + envelope + **all** source blobs (including superseded
versions/behavior sources), exclude live ownership/staging/derived/migration state,
restore with the **same identity** to a clean directory. Template creation to a
new identity is a different operation, not a restore shortcut. Back up independent
game build metadata/engine pin/lockfiles too. Include the engine kit itself, or
reference an independently retained, hash-verified kit artifact whose restoration
is actually tested with the original kit unavailable. A digest alone cannot recover
an unpublished dirty-tree kit; a runnable export is not a source backup. Browser
layout can be discarded.

Provide a bounded verify/copy/restore tool and runbook, not a scheduler, archive
marketplace, background daemon or in-place restore. Freeze limits, inventory hashes,
path containment/symlink refusal, destination-exists refusal and publication/crash
semantics. Verify restore through real workspace load/integrity and fresh Play/export
without relying on old caches. Never run destructive drills on the owner's project.

Diagnostics use existing query/job/runtime surfaces where possible, with small typed
additions only when accepted. Report stage/code/project revision/build/run identity,
capability degradation and ownership/resource counts without tokens, raw source,
absolute server paths or unbounded logs. UI and MCP share codes. Errors suggest a
safe next action; they must not silently repair corrupt data, steal ownership or
claim a stopped run recovered. No telemetry service.

### 2.6 Reference-device budgets — 63, 67, 79–80

No numeric product budget is invented in this plan. 63 establishes the executable
measurement harness and records the proposed reference desktop with the owner;
67 freezes the protocol at Q. Numerical targets require a **representative-scene
calibration checkpoint**: if 63 cannot measure functioning representative media,
67-B remains deferred and resumes after 76/78 on the completed independent game,
before 79's scored runs. Record that resumption in `handoffs/67-budget-ratification.md`;
review/promote the numeric table and obtain owner target confirmation separately.
Early incomplete-scene timings are diagnostic baselines only.

If hardware is unavailable, explicit partial Q/T/U verdicts may let independent
software work, 81's non-performance evidence and 82's executable owner runbook
finish. C11 remains UNVERIFIED; 79 records the missing-device result and 80 makes
no unsupported optimization claim. The deferred 67-B→79→80 performance branch
and affected T/U review must complete on the exact final candidate before owner
acceptance. A demonstrated required-budget FAIL blocks T, rather than being
relabelled hardware-unavailable. M4 performance acceptance cannot pass on
SwiftShader or on a blank/box-only scene.

Required budget record: CPU/RAM/GPU/driver/OS/browser build, display refresh,
viewport/resolution/DPR, WebGL backend, power mode, host topology/network/cache
conditions; exact template/independent-game content digest, engine pin, quality
profile and input route. Measure editor viewport, isolated Play and standalone
separately. Baseline/proposed targets/accepted thresholds are separate columns.

Protocol proposal to freeze at Q: 30 s warm-up, three 120 s visible-tab traversal
runs per host; three cold-cache and three warm-cache load runs; 20 Play/stop cycles
and a 10-minute active-run soak. Measure frame intervals p50/p95/p99 and missed-frame
rate, render CPU and whole fixed-step CPU cost/catch-up drops, draw calls/triangles,
live object/texture/geometry/audio/listener counts, total transfer bytes and load-to-
first-frame/ready time. Name timer resolution and sampling overhead. GPU duration
only if supported and non-disjoint; JS heap/GPU memory are labelled observed or
estimated, never inferred from object counts. Propose numerical ceilings and bounded
noise allowance from observed distributions; architectural review and owner target
confirmation precede acceptance. Counters after disposal must return to their
explicitly defined baseline; do not infer a leak solely from process RSS.

Before calibration/scoring, 79 rebuilds/re-pins the kit using 75's tooling to
include any 78 changes, preserving customized game sources. 80 repeats kit rebuild/
re-pin after each accepted engine repair. Both repeat isolated builds/scans and
record the exact candidate identity; 81 verifies that monorepo, kit and measured
candidate agree. Earlier pin records remain historical evidence, not a reason to
test an obsolete engine. Engine re-pinning here is release-candidate assembly,
not automatic upgrades of existing user games.

79 measures the completed representative game against those thresholds. 80 may fix
only measured hotspots within existing modules and then remeasure identical inputs.
No dependency upgrade, instancing system or architecture rewrite without a separate
contract review. If budgets fail, report FAIL; do not reduce scene quality/size,
change the reference device or relax targets after seeing the result without a
recorded new decision and fresh runs.

## 3. Contract and module ownership

63–68 produce **proposals**, under `planning/m4-contracts/`, not accepted edits.
64 owns delivery/render/query repairs; 65 template/initialization/layout/module
rules; 66 engine kit/public build interface; 67 backup/diagnostics/performance.
68 reconciles exact section diffs, version effects, export additions, import edges,
fixture evidence and every consumer. Proposed new homes: `templates.md`,
`distribution.md`, `reliability.md`. Existing model/commands/workspace/runtime/
sessions/export/dependencies/presentation sections change only through that inventory.

Prefer no scene/storage/export schema bump: template/distribution/layout metadata
is not gameplay state. If module/provenance data must persist inside an accepted
closed document, 65/66 must specify a real versioned migration/compatibility diff;
no unversioned extra keys. No new package is presumed. Tools orchestrate public APIs;
workspace remains the only authoritative state writer. Any new unit/export/edge
requires exact dependency-contract and scanner changes at Q before implementation.

## 4. Execution and gates

| Gate | Packets | Required verdict before continuing |
|---|---|---|
| Plan review | this planning set | architectural review + separately recorded owner execution authorization |
| Q | 63–68 | evidence baseline, exact contracts/fixtures, debt disposition; bounded repair then explicit docs-only promotion before 69 |
| R | 69–71 | real delivered rendering/motion, query parity; no missing model visual passed as hardware-only |
| S | 72–76 | safe template creation, layout/module separation, portable pinned engine kit and independent game |
| T | 77–80 | recovery/backup, bounded diagnostics, measured budget results and optimization regressions; hardware-only partial route per §2.6 |
| U | 81–82 | integrated acceptance and executable owner runbook; distinguish software completion from pending owner evidence; partial T cannot become final U acceptance |

Each gate has its own review handoff and explicitly owned follow-ups. A failed
contract reopens the affected gate, not arbitrary adjacent scope. Tests use real
filesystem/subprocess/stdio-MCP and browsers where relevant, not mocks alone.
Do not create implementation handoffs, acceptance results or proposed-contract
files now; these are future packet outputs. After 82/Gate U, stop for the owner
checklist. No later milestone is authorized automatically.
