# M2 — Content and behavior: proposed plan

Status: **DRAFT — architectural review required before execution.**
Baseline: accepted M1, repository `5b746ee`; planning only, no feature implementation.
Packet index: [m2-packets.md](m2-packets.md). Acceptance: [m2-acceptance.md](m2-acceptance.md).
Planning handoff: [../handoffs/m2-planning.md](../handoffs/m2-planning.md).

This executes the planning request in implementation-prompts.md, “After M1”.
It does not approve new dependencies, change accepted contracts, or start packet 14.
All choices below are **proposals**, not owner rulings. Review this plan first;
then packets 14–19 produce evidence and exact contracts for Gate E. Production
implementation starts only after Gate E acceptance and required owner decisions.

## 1. Outcome and scope

At M2 completion a user can import a small self-contained GLB, inspect its model,
materials and animation clips, place it in a scene, reimport it without breaking
whole-model references, make and instantiate a basic prefab, edit declared behavior
properties, and play a small collision test course with keyboard or gamepad.
The same content and behavior run from an independent static export. UI and MCP
use the same durable command path throughout.

This is a **capability test course, not the M3 sample game**: no start screen,
win condition, hazards, respawn/checkpoints, audio, HUD authoring, progression,
or animation state machine. A diagnostic overlay and fixed test camera suffice.

| Charter/roadmap item | Proposed assignment |
|---|---|
| Stable assets, GLB import/reimport, model/material/clip inspection | M2 |
| Prefab creation and materialized instantiation | M2; no linked updates, nesting or variants |
| Declared properties and trusted project scripts | M2, behind explicit execution-boundary review |
| Keyboard/gamepad, static 2D collisions, 2.5D controller | M2 |
| Transform snapping | M2 packet 27; local translate/rotate/scale increments |
| GLB-authored PBR materials and neutral preview lighting | M2; enough to inspect imported content |
| Editable lights/shadows and reusable material presets | **M3 planning input**, not silently included in M2 |
| Runtime animation selection/blending, follow camera, audio, HUD | M3; M2 only clip preview and a static side-view camera |
| Reference-device product budgets, templates, independent project setup, backup UI | M4; M2 still measures the physics spike and verifies recovery/export |
| Loose `.gltf` plus sidecar bundles, Draco/KTX2/Meshopt, hostile code, dynamic rigid bodies, moving/one-way platforms | Deferred; not implied by accepting GLB or physics |

## 2. M1 constraints that materially change this plan

Inspected inputs: charter; decision 0001; accepted public contracts (relevant
model/version, command pipeline, storage, runtime, session/isolation, export and
dependency sections); M1 report including owner observations; public model,
commands, workspace, runtime, protocol, adapter and exporter exports/types.
No full repository ingestion or implementation audit was performed.

1. **Storage is not a general project database.** `workspace.md` §§3–5 admits
   one mutable envelope, an immutable manifest and no multi-file transactions.
   Imports/prefabs/scripts cannot add independently mutable catalogs beside it.
2. **Schema v1 is closed.** New components/booleans require a version change;
   unknown versions must remain non-destructive. The existing migration functions
   are identity-only. A dual-version and migration policy is needed, not casts.
3. **Runtime registry is M1-only.** It links only box motion. Input, physics and
   script modules require reviewed exports and scheduling changes. Copying
   `curr` does **not** roll back a WASM world or private script state.
4. **Snapshot identity is currently only project + revision.** Uncommitted asset
   or source-code changes must not change the meaning of an existing snapshot.
5. **Preview/export network policy is deliberately narrower than M2 needs.**
   M1 permits one engine fetch in export and no preview content fetch; bundle
   graphs/options/scanner exceptions are exact. Asset/WASM/code delivery requires
   an explicit replacement policy, never a broad scan exemption.
6. **Public mutations and projections are closed unions.** Every new command
   needs validation, inverse/history, retry serialization, projection, query and
   MCP coverage; a panel that writes a file directly is not an implementation.
7. **Browser proof is incomplete.** M1 was accepted, but U-1 still covers real
   screenshot, console/network details and other pixel checks. It is not evidence
   that gamepad, GLB or physics work. M2 final acceptance requires real browsers.

Carry-over disposition (do not reopen unrelated M1 work):

| M1 item | M2 owner/checkpoint |
|---|---|
| U-1 residual browser checks | 14 establishes a usable browser path; 26/30/35/37 collect real evidence |
| U-2 transient first export fault | 33/36 test cold deployed-process builds; investigate if reproduced, no speculative root-cause claim |
| U-3 conservative process marker | 37 validates documented launcher/ownership behavior; do not weaken liveness |
| U-4 `engineRoot` and reference-entry requests | 19 requests explicit disposition before adopting delivery contract changes |
| U-5 Playwright pin | 14 chooses manual desktop or separately approved automation; no automatic install |
| Gate A missing milestone assignment for snapping/lights/materials | Assigned in §1 above |

Historical M1 status rows and old handoffs remain historical. This plan adds its
own progress rows rather than “cleaning up” their stale narrative.

## 3. Proposed contract briefs

These are bounded design directions for packets 15–19, **not normative schemas or
implemented APIs**. Those packets must supply exact TypeScript-facing shapes,
JSON fixtures, defaults, size limits, error/status mapping and contract diffs.
If review rejects a direction, revise the affected plan before implementation.

### 3.1 Authoritative content and immutable storage (15)

Keep one active scene and one authoritative revision. Proposed storage v2 adds a
bounded `content` block alongside `scene` and `retry` in the same envelope.
It contains asset records, immutable prefab definitions, behavior declarations
and published source references, plus bounded gameplay settings. `scene.revision`
remains the sole current project revision. This is not a second catalog file.
Scene schema v2 introduces typed render-model/behavior/collider/controller fields;
manifest v1 remains immutable. Explicitly define and validate the supported
manifest-v1/scene-v2/storage-v2 combination rather than relying on M1 assumptions.

Authoritative binary/source bytes are immutable, content-addressed blobs under
project-relative `sources/sha256/<digest>`. Derived imports/builds live separately
under `.thirdlight/` and are keyed by source digest, recipe and exact tool versions.
The workspace owns paths, ownership, blob publication and envelope commits;
import/build workers receive bounded bytes/configuration, not authority over state.

Publishing order: validate/stage → durably publish immutable blobs → recheck project
ownership/revision and run the normal command pipeline → atomic envelope commit
and durable retry record → notification/ack. A crash before the last step may
leave **unreferenced immutable bytes**, never acknowledged dangling references.
An identical command retry replays before looking for an expired staging handle;
no long job holds the project mutation lock. Stale job results remain proposals
until deliberately resubmitted against a fresh revision/request ID.

No M2 garbage collection: retained blob versions support undo, snapshots and
retries. Bound uploads/staging, disk quota, concurrency and timeouts; fail before
publication when full. Abandoned stages may be cleaned only under an explicit
non-authoritative retention policy. Missing/corrupted authoritative blobs fail
closed with actionable diagnostics. Derived caches can be regenerated from pinned
sources/recipes, never by fetching arbitrary URLs. Backups include the envelope,
manifest and **all authoritative source blobs**, not only JSON.

Migration is explicit and non-destructive: validate M1, produce a converted copy
under a new project identity/destination through an operator workflow, retain the
old project byte-for-byte, reset history/retry across that new-project boundary
and report the new identity/revision policy. No silent upgrade on open, no partial
manifest/envelope upgrades, no downgrade. Packet 15 must resolve creation/crash
completion for the copy and preserve ordinary M1 loading/editing/export paths.

### 3.2 Asset identity, import and reimport (15)

An opaque `assetId` is independent of filename, display name and content hash.
A model component references the **whole GLB** by assetId. Catalog versions pin
source digest and import recipe. Runtime snapshots resolve assetId to immutable
versions so active play/export cannot change during reimport.

M2 profile: glTF 2.0 **GLB only**, embedded buffers and PNG/JPEG images, core PBR
materials, bounded meshes/nodes and embedded animation data. Specify a small
supported extension allowlist after testing the pinned loader (unlit is a
candidate). Reject remote/external URIs, unsupported required extensions,
compression, malformed chunks/accessors, excessive decoded geometry/image sizes
and invalid animations before a successful import. MIME/extension checks alone
are insufficient. No URL import, archive extraction or arbitrary importer plugin.

Whole-model placement preserves the GLB's internal hierarchy under one editor
entity. Internal glTF node/material/clip names and indices are **not stable engine
IDs**. They may be inspected in previews; persistent references to submeshes,
material slots, bones or clips are excluded. Reimport may change those internals
without promising impossible name/index stability. A failure preserves the prior
asset version, scene, revision and reference set. A success changes one catalog
version via a command; referenced entities keep their IDs and transforms. Undo
restores the old asset version; existing play retains its pinned bytes.

Rendering uses one shared three-adapter GLB realization/resource owner, called by
editor viewport, asset preview and play/export hosts. UI never instantiates a
second persistent scene. Clip play/pause/scrub is local preview state, not runtime
animation authoring. Cancellation/disposal must release textures, images, mixers,
geometries, object URLs and stale asynchronous load results.

### 3.3 Prefabs, typed properties and commands (16)

Use **materialized copy-on-instantiation prefabs**, not a live inheritance system.
Create a definition from one selected subtree, excluding the required scene camera.
Definitions have stable prefab IDs and stable local entity IDs; M2 definitions are
immutable (make a new definition to change a design). No nested prefab instances,
variants, automatic propagation, apply/revert overrides or structural overrides.

Instantiation remaps every local entity/reference ID once and records the mapping
in the durable result. One transaction creates the complete subtree; one undo
removes it and redo restores exactly those IDs. Allow only an explicit root
transform and typed declared-property overrides at instantiation. Subsequent edits
are ordinary edits of the materialized entities, with provenance informational;
changing another definition cannot rewrite them. Missing dependencies, cross-scene
references, external entity references inside a definition and entity-count overflow
reject the whole operation. Do not offer linked-instance UX for copy semantics.

Declared properties have stable keys, labels, typed defaults and validation:
finite bounded number, boolean, bounded string/enum, Vec3, entity reference and
asset reference. No functions, arbitrary object graphs, accessor execution or
schema discovery by evaluating scripts. Declarative schemas are data validated
by project-model. Changing a declaration/source version requires explicit
compatibility validation for all uses; do not silently drop unknown overrides.

New operations are bounded typed commands, not arbitrary JSON Patch/eval. Contract
16 names exact publish-asset, create-prefab, instantiate-prefab, set-component,
set-behavior-properties/settings and publish-behavior operations and their queries.
Every authoritative change includes expectedRevision/requestId and has defined
inverse, no-change, retry, failure and projection semantics. No general atomic
batch API unless a specific operation cannot express the required transaction.

### 3.4 Input, physics and the controller (17; evidence from 14)

Proposed physics choice: **Rapier 2D**, browser-compatible distribution selected
and exactly pinned only after packet 14's build/browser evaluation and approval.
A 3D visual scene does not require 3D collision. All colliders share an XY plane;
Z is visual depth only, not a collision lane. This tradeoff is deliberate.

M2 supported shapes: authored static boxes and bounded convex polygons (ramps),
a single upright kinematic capsule character, no dynamic bodies, joints, sensors,
moving platforms, one-way surfaces, mesh-derived colliders or arbitrary parenting.
Physics-bearing entities are roots with unit scale and permitted XY rotation;
unsupported transforms are validation errors, not silently flattened geometry.
The character's Z and rotation remain authored/locked; mesh children may carry
visual offsets. Exactly one player controller in the M2 test scene.

Input provides `moveX` in [-1,1] and `jump` pressed/held/released. Keyboard defaults
are A/D or arrows and Space; standard-mapped gamepad uses left-stick X/D-pad and
primary face button. Specify dead-zone rescaling, simultaneous source arbitration,
edge consumption once per executed fixed step, focus/text-field suppression,
visibility changes, disconnect clearing and fresh activation after resume. No
raw DOM/Gamepad objects in runtime core. Nonstandard mappings report unsupported;
no remapping UI in M2. Gamepad availability, secure context, user activation and
cross-origin iframe permission must be tested, not assumed from WebGL support.

Fixed-step ordering is explicit: sampled action frame → validated behavior intents
→ controller intent/gravity → collision correction/physics → authoritative runtime
transforms → read-only interpolation/render. One owner per character transform;
box-motion demo cannot also control it. Keep 120 Hz and eight-step catch-up cap;
dropped wall time executes no phantom physics/input steps. Jump edges must not be
replayed on every catch-up step. Replay tests use recorded step-indexed actions,
not wall-clock events; no cross-platform bit-exact WASM determinism claim.

Grounding comes from collision results/support normals, not `y == floor` or just
zero vertical speed. Contract 17 fixes numerical tolerances/defaults for gravity,
speed, acceleration/deceleration, capsule dimensions, skin offset, ground snap,
maximum climb angle, steep-slope sliding, head impacts, maximum fall speed and
high-speed collision handling. Proposed gameplay: a single jump, variable height
on release, coyote time and jump buffer expressed in integer steps; no air jump,
wall jump or automatic stair climbing. Tests bracket the allowed slope angle,
exercise seams/ledges/ceilings and show no false grounded state while ascending.
A static perspective camera looks toward -Z with Y up; following is M3.

**Stateful failure rule:** copying transform maps cannot restore physics private
state. Propose fail-stop of the entire M2 simulation after a module error: retain
last completed render state, report the failed module/step, allow disposal and
fresh restart only. No continued stepping with a half-mutated world. Define exact
lifecycle/diagnostic changes and initialization cancellation before implementation.

### 3.5 Trusted project scripts and builds (18)

Propose deliberately limited **trusted personal TypeScript behaviors**, compiled
without executing them on the server and linked into a per-snapshot browser bundle.
No arbitrary URL modules, npm project dependencies, build plugins, shell hooks,
server eval or backend module imports. Dependencies are an explicitly published
local source graph plus a small runtime behavior API. The harness can edit source
files in a declared staging area; **publishing their captured bytes and declaration
is a command that advances the revision**. The order is stage source/declaration →
validate and compile the captured graph → prepare a digest-bound successful result →
atomic publication through `runCommand`. Public behavior publication is unavailable
until packet 33 supplies that preparation path; early pure-command fixtures do not
claim a working script publisher. No filesystem watcher implicitly changes a running
snapshot. Compilation errors are bounded diagnostics, not partial publish. A later
full play/export bundle build can still fail without undoing a valid publication;
that failure preserves the last successful derived artifact.

The behavior API reads its declared properties and action/state views and emits
validated controller intents or changes to explicitly owned non-physics runtime
transforms. It cannot persist authoring edits, access workspace services, mutate
the physics world directly, or spawn entities in M2. Define conflicts/multiple
writers, per-instance private state, deterministic ordering, disposal, exception
handling and log/intents limits. No implementation dependency on UI/MCP packages.

**Important trust limitation:** proposed execution is in the separate-origin
preview's main JS context (and the standalone game's context). API restrictions,
static import checks and CSP are defense in depth, **not a hostile-JavaScript
sandbox**. A same-thread infinite loop cannot be reliably timed out; no watchdog,
iframe removal or Stop button is claimed to preempt it. Scripts can observe globals
available in their game origin. Trust must be explicitly acknowledged before first
execution; authoring credentials never enter the preview. Review must explicitly
accept this personal-project boundary. If hard preemption or hostile code is
required, stop and design a worker/process execution contract separately—do not
smuggle an asynchronous worker scheduler into these packets.

Exceptions in cooperating scripts use the stateful fail-stop rule. No eval/dynamic
remote loading, state-preserving hot reload, unrestricted script inspector or shell
MCP tool. Code edits require publish/build and a fresh play instance. Use one tiny
example behavior with a declared numeric property to prove actual execution;
a schema-only UI is not completion of this scope.

### 3.6 Snapshot delivery, preview isolation and exports (19)

Add one immutable runtime-content manifest: scene, resolved asset/source versions,
required engine modules, recipe/toolchain versions and build identity. Everything
that affects content/behavior must be captured at one authoring revision. Derived
build digest also identifies engine/toolchain/options; do not equate project@revision
with an engine-independent binary hash. Build failure preserves the previous output.

The authoring viewport first obtains committed GLB bytes through an authenticated,
project-scoped, immutable-version asset-read endpoint (packet 25). It passes bytes
or an injected resolver to rendering helpers; the renderer receives no authoring
token. This endpoint is not the preview delivery path and cannot expose staged or
arbitrary project files.

The authoring side requests a build through authenticated project services. Only
completed immutable artifacts are exposed to the preview, using a narrowly scoped,
read-only play-content locator with bounded lifetime. No authoring token or general
project filesystem endpoint enters that frame. Its unguessable locator is still a
bearer capability: redact it in logs, prohibit listing/traversal/cross-project
access and exclude it from exports. Specify expiry, authorization, CSP/referrer,
cache behavior and cleanup; a reconnect/reload must not resolve to newer bytes.

The preview fetches only its immutable static content, not `/api/v1` or workspace
queries. Keep exact-origin/source/nonce bridge checks. Version the changed bridge
and validate payload limits. Mark play ready only after assets, physics and behavior
build are ready, with explicit bounded load failure/cancellation and truthful UI.
Do not put GLB bytes or compiled scripts in WS full-state frames.

Exports include the same runtime/module/build pipeline and the complete reachable
closure of GLBs, behavior code and WASM (if separately emitted), all relative to
the output tree. No authoring credentials, capability URLs, host paths, CDN fetches,
Node/server packages or backend availability requirement. Engine fetches are
allowlisted relative artifact reads, replacing M1's one-fetch rule **only through
an approved contract diff**. Binary container strings cannot be handled by simply
running the old textual bundle regex over GLB/WASM; define format-aware resource
validation plus JS import/content scans and actual browser network assertions.
License notices and exact versions/hashes belong in the output metadata.

A bounded input-exercise relay for MCP sends semantic actions to one presented
playSessionId for a finite step count and reports applied step range/snapshot ID.
It is not DOM event injection or eval. Physical and injected inputs must not race:
use an explicit exclusive test-input mode that clears on completion/stop/disconnect.
No browser means the existing structured unavailable behavior, not simulated success.

## 4. Proposed package ownership

No directories/stubs are created by this plan. Packet 19 must approve exact exports,
new import edges and package pins before any corresponding implementation.

| Unit | Public responsibility / proposed direction |
|---|---|
| `project-model` | Pure content schemas, references, migration and prefab instantiation helpers; no engine/library handles |
| `commands` | Typed edits, inverse/history; imports model only |
| `workspace` | Sole authoritative executor, blob/stage storage, immutable snapshot capture; model + commands + approved Node I/O |
| new `asset-pipeline` | Pure bounded GLB inspection/import recipe over supplied bytes; injected job/storage ports; no panels or state commits |
| `runtime` | Scheduler, module phases, action/physics/behavior service types and lifecycle; model only, no concrete physics import |
| new `input` | Pure action mapping plus explicit browser attachment entry; imports runtime types, no authoring transport |
| new `physics-rapier` | Concrete 2D collision world/character adapter; runtime types + approved Rapier only |
| new `platformer` | Controller algorithm over injected input/physics ports; runtime types; no concrete physics dependency |
| new `behavior-build` | Node-side static source validation/compile using approved esbuild, injected I/O; no source execution |
| `three-adapter` | GLTFLoader realization, resource ownership, render/preview helpers; runtime + three; no storage imports |
| `protocol` | Sole pure wire shapes; no duplicate schemas in clients |
| `backend` | Services/HTTP/WS, bounded job coordination, immutable artifact serving; injected workspace/import/build services |
| `editor` | React panels, imperative viewport, commands/projection and preview host; no direct authoritative writes |
| `mcp-adapter` | Existing real SDK/stdio/backend path; bounded content queries/edits/jobs/input relay, no filesystem bypass |
| `exporter` | Build orchestration from injected captured snapshot/source readers; browser bootstrap composes approved runtime modules |

Browser bootstraps inject concrete adapters. Runtime core does not import input,
Rapier, platformer or script compiler packages. No new universal service bus/plugin
framework. Shared build functionality must have one owner (`behavior-build`), not
separate play and export compilers. Boundary checks cover Node and every generated
browser graph, including user-source imports and workers if ever separately approved.

## 5. Sequencing and review discipline

One packet per task/session, sequential integration, no shared-tree concurrent edits.
Each packet has an exact read set, write scope, proposed public surface and evidence
requirements in m2-packets.md. Public names there are provisional until Gate E.
No dependency upgrades or service installations as incidental cleanup.

| Gate | Packets | Required review |
|---|---|---|
| Plan review | this deliverable | Scope, choices, packet sizes, physics evaluation and script trust proposal |
| E | 14–19 | Actual evaluation + exact schema/persistence/runtime/security/delivery/dependency contract diffs and fixtures; owner pin/trust decisions |
| F | 20–25 | Model/commands/blob durability/import/backend/MCP; real crash/retry/security evidence |
| G | 26–28 | Asset/prefab/property/snapping authoring workflow; real browser evidence and M1 regression |
| H | 29–32 | Stateful runtime, physical keyboard/gamepad, actual physics/controller course; measured CPU/build evidence |
| I | 33–36 | Script execution boundary, immutable play delivery, input relay, standalone content/gameplay export |
| J | 37 | Integrated M2 report, browser/gamepad/export evidence and all carry-over dispositions |

An implementation contract change reopens its relevant Gate E portion and any
later dependent gate. Gate acceptance is recorded by review, never inferred from
a handoff. Bounded follow-ups have named owners and checkpoints; unresolved safety,
durability, gameplay or independence failures block the dependent packet. Record
unavailable visual evidence honestly and leave the gate incomplete where it is
required. Do not automatically start the next packet or M3.

## 6. Decisions required, not silently made

- Plan reviewer: copy-on-instantiation prefab semantics, whole-GLB references,
  GLB-only initial profile, static 2D physics limits and M3 rendering assignments.
- Packet 14 + owner: real desktop/browser/gamepad and reachable secure-context
  verification path; whether separately pinned browser automation is wanted;
  exact physics package/version/license/build choice after measured evaluation.
- Gate E + owner: explicit trusted-main-thread script boundary (no hard timeout),
  all contract diffs/import edges/new dependencies, and U-4 dispositions.
- Contract authors: exact numeric limits/defaults/tolerances/error schemas. They
  must resolve these in fixtures **before** implementation, not leave them to
  downstream agents. Runtime tests and final acceptance use those fixed values.

No owner response is needed merely to review this draft. A rejected proposal
returns here for a bounded plan revision, not an unrecorded implementation choice.
