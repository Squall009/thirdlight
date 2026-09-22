# Decision 0002 — M2 content and behavior

Status: **APPROVED — owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.** Gate E accepted every proposal/diff
row 2026-09-18 (`docs/handoffs/gate-e.md`) and the docs-only promotion applied
the accepted text into `docs/contracts/` the same day
(`docs/handoffs/m2-promotion.md`). This is a recorded **pre-approval**, not an
independent reviewer approval; §§1–6 are binding contract/decision text from
this date (AGENTS.md: accepted contracts and decisions are binding).
Created by packet 14 (2026-09-18). Sections are added by the packets that
own them; the per-section notes below record what each stands on.

| § | Topic | Drafting packet | Status |
|---|-------|-----------------|--------|
| 1 | Physics engine + distribution selection | 14 | **approved (owner pre-approval 2026-09-18; final manual review pending)** — selection still **PROVISIONAL** pending the desktop/browser/gamepad evidence; the pin enters the lockfile only at packet 31 |
| 2 | Content storage, asset identities, migration | 15 | **approved (owner pre-approval 2026-09-18; final manual review pending)** |
| 3 | Typed edits, prefabs, declared properties | 16 | **approved (owner pre-approval 2026-09-18; final manual review pending)** |
| 4 | Stateful runtime, input, 2.5D physics contract | 17 | **approved (owner pre-approval 2026-09-18; final manual review pending)** |
| 5 | Trusted behavior execution and compilation | 18 | **approved (owner pre-approval 2026-09-18; final manual review pending)** — trust boundary owner-pre-approved, no sandbox and no hard timeout |
| 6 | Delivery, protocol, export, dependency integration | 19 | **approved (owner pre-approval 2026-09-18; final manual review pending)** — U-4 both accepted, fail-closed |

## Promotion record (2026-09-18, docs-only)

Recorded by the promotion step; normative text lives in `docs/contracts/**`.

- **Physics engine / distribution / pin.** `@dimforge/rapier2d-compat` at
exactly `0.20.0`, `-compat` distribution (WASM embedded in the bundle; no
separate WASM fetch), kinematic character controller with a parentless
collider. Integrity
`sha512-FFYwGrfJov7d5kn4fxblG/ip5C+sYQL+Jl/hqLvDvu4BcMD/Mhrz7cTvnZTtuIRDXY8CLuraObqB/prip4wdWQ==`,
Apache-2.0, zero runtime dependencies. **Contract text only: no install, no
lockfile change; the pin enters the lockfile at packet 31.** The selection stays
**PROVISIONAL** until the desktop evidence is recorded (see §1).
- **Trusted-main-thread script execution boundary.** Trusted main-thread
TypeScript behaviors, compiled without server-side execution; **no hard runtime
timeout and no hostile-code sandbox**; the static import/dynamic-code
restrictions and the output scan are defense in depth only. The durable trust
acknowledgment gate is binding; a hard boundary would require a separate
execution-boundary design packet (`contracts/runtime.md` §14,
`contracts/project-model.md` §22).
- **Per-package units, edges and pins (recorded for approval).** New units
`asset-pipeline`, `input`, `physics-rapier`, `platformer`, `behavior-build`
(Node-side compiler, plan §4 naming); the browser behavior surface lives in
`runtime` (no `behaviors` package); no new GLB pin (the pinned `three@0.186.0`
GLTFLoader subpath is used); the compiler reuses the pinned `esbuild@0.28.2` and
`typescript@5.9.3`. All edges/pins are contract text; nothing is installed
(`contracts/dependencies.md` §§2–7).
- **U-4 dispositions: both accepted, exactly as implemented fail-closed.**
(a) optional `engineRoot` backend config + `THIRDLIGHT_ENGINE_ROOT`
(`contracts/sessions.md` §13.7); (b) the export.md §5.4.1 reference-build entry
`import * as THREE from 'three'; console.log(THREE.REVISION);` with the table
counts unchanged (`contracts/export.md` §5.4.1). Gate C CF-2/CF-3 are the same
two items and are disposed by this entry.

Every section below was written under, and is now approved by,
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final manual
review pending** — a pre-approval, not an independent review and not an
independent owner approval beyond the recorded instruction. Gate E accepted the
proposal rows and the docs-only promotion marked §§1–6 approved on 2026-09-18;
no packet and no independent reviewer is claimed as the approver.

## 1. Physics engine and distribution (packet 14, approved — selection PROVISIONAL)

### 1.1 Evidence base

`docs/acceptance/evidence-m2/14/` (manifest: claims → artifacts). Bounded
evaluation of Rapier 2D (compat + non-compat), Rapier 3D (desk-research
elimination, labeled), Planck 1.5.0, and cannon-es 0.20.0 against one frozen
static course (`course-spec.json`: 64 static colliders — flat floor with a
2 cm seam, 43°/47° ramps, wall face, ceiling, 0.4 m ledge — 120 Hz fixed
step, capsule r=0.3/hh=0.6, g=−19.62). All runs in a container under
Node v22.22.1 on an i5-12600H: **directional, not reference-desktop,
numbers** (plan-review BR-2).

- **Rapier 2D (character controller)**: passes all 10 course phases
  deterministically (two byte-identical runs). Fixed-step cost with
  1 kinematic capsule + 64 static colliders: controller p50 ≈ 0.004 ms,
  total p99 ≤ 0.031 ms against the 8.333 ms tick budget. Cold init
  73–77 ms (fresh Node processes).
- **Planck / cannon-es (JS, no WASM)**: no built-in kinematic character
  response — measured: kinematic bodies pass through static walls, do not
  climb 43° ramps (Box2D-derived edge handling), and grounding requires
  custom raycasts (cannon-es additionally needs collision-filter groups to
  avoid self-hits in those raycasts; neither ships a capsule shape).
  Choosing either means M2 re-implements the character-controller layer
  that Rapier provides built in.
- **Rapier 3D**: eliminated by desk research for the 2.5D proposal
  (collision stays in XY; 3D solver adds Z-axis edge cases and a larger
  WASM for no M2 benefit). Labeled elimination, no benchmark row.
- **Distribution**: `@dimforge/rapier2d-compat@0.20.0` (base64-embedded
  WASM, no runtime WASM fetch → no CORS surface for the WASM itself; one
  inert `fetch(` pattern recorded for the packet-19 scan) vs
  `@dimforge/rapier2d@0.20.0` (separate WASM binary → extra CSP/CORS
  surface). The IIFE bundle of the compat entry under the exact export.md
  §5.3 pinned flag set is 2,169,354 bytes unminified and executes
  standalone (verified in Node; browser execution pending desktop evidence).

### 1.2 Selected engine and distribution (approved; selection PROVISIONAL)

> **APPROVED at Gate E 2026-09-18 (owner pre-approval; final manual review
> pending) — selection PROVISIONAL.** The contract text and the pin are
> approved, but the selection stays provisional until the owner's desktop
> evidence (manifest §"Manual desktop evidence procedure") is recorded; the
> desktop/browser/gamepad items are **UNVERIFIED** and carried to the final
> owner checklist. The pin enters the lockfile only at packet 31, so the
> packet-31 adapter works from this approved-but-provisional decision (no
> dependent approval is claimed beyond it). CPU/init numbers remain
> container/directional (BR-2).

1. **Engine: `@dimforge/rapier2d-compat`** at **exactly 0.20.0**
   (integrity `sha512-FFYwGrfJov7d5kn4fxblG/ip5C+sYQL+Jl/hqLvDvu4BcMD/
   Mhrz7cTvnZTtuIRDXY8CLuraObqB/prip4wdWQ==`, Apache-2.0, zero runtime
   dependencies). The pin is **approved by this decision (Gate E, 2026-09-18;
   owner pre-approval; final manual review pending)** and enters the lockfile
   only at packet 31 — never before.
2. **Distribution: the `-compat` variant** (WASM embedded in the JS bundle):
   no separate WASM fetch, which fits the export contract's one-fetch
   browser model (export.md §5.3/§5.4.1) and avoids a WASM CORS/CSP surface.
   Trade-off accepted: ~7.6 MB unpacked package, ~2.1 MB unminified IIFE
   bundle for the probe — acceptable for a self-hosted desktop game editor.
   The non-compat `@dimforge/rapier2d@0.20.0` is the documented alternative
   if owner preference changes (smaller package, but a runtime WASM fetch
   would need an explicit contract treatment).
3. **Character model: Rapier's kinematic character controller**
   (`world.createCharacterController(offset)` +
   `computeColliderMovement`/`computedMovement`/`setTranslation` loop,
   parentless collider — the documented 0.20.0 pattern), slope settings
   per the M2 behavior contract (climb ≤ 45°, slide ≥ 30° in the frozen
   course), `enableSnapToGround`. M2 game logic keeps the canonical model
   verified in the probe: grounded ⇒ vy=0, jump edge ⇒ vy=7, free-fall
   gravity otherwise; adapter guard: never command a downward delta while
   grounded (degenerate-input check passed, but the guard is kept).
4. **Strict-TS accommodation**: the M2 runtime package's `tsconfig` adds
   `lib: "esnext.disposable"` (additive per-package entry; the candidate's
   `.d.ts` uses `Symbol.dispose`). No repo-wide lib change, no
   `skipLibCheck` relaxation; negative control confirmed strictness stays
   intact.
5. **Runtime budget (approved; numbers directional)**: one Rapier `World` per game; fixed 120 Hz
   stepping inside the runtime scheduler's catch-up window (runtime.md §5);
   controller + step measured ≤ 0.031 ms p99 (directional) vs the 8.333 ms
   tick budget; cold init 73–77 ms (directional) must fit the preview
   bootstrap budget measured at packet 35.

### 1.3 Known limitations carried into later packets (approved; browser/desktop items UNVERIFIED)

- **Parented-collider trap**: parenting the character collider to a rigid
  body makes the solver re-sync it toward the body and breaks the
  `computeColliderMovement` loop. The adapter (packet 31) must use the
  parentless pattern and document it.
- **1-step horizontal stall jitter** at existing floor contact (average
  speed unaffected) — contract 17 (packet 17) should specify whether the
  runtime smooths or passes this through.
- **First-step ~1.4 mm grounded-settle dip** — contract 17 initialization
  note (declare a settle pre-roll before gameplay, as the probe does).
- **Browser-side items UNVERIFIED in the container** (no browser/GPU/
  gamepad): rendering M1 + probe bundle over the intended topology, WASM
  init under real CSP, `getGamepads` exposure, gamepad policy in the
  cross-origin preview frame. The desktop procedure (evidence manifest)
  must pass before the selection stops being PROVISIONAL; if plain-HTTP LAN fails
  `getGamepads` (secure-context rule), the owner picks the localhost/TLS
  topology before packet 30.
- **CPU numbers are container/Node** (BR-2): a labeled desktop
  re-measurement is available via the same probes; the selection decision
  does not depend on it (margin is ~270× at p99), but acceptance of the
  performance claim does.

### 1.4 Owner decision points (recorded at promotion, 2026-09-18)

All four are **recorded as approved under the owner pre-approval** (final manual
review pending); items 3–4 remain open evidence items, not blockers:

1. Approve or change the engine/distribution/pin — **approved as proposed**
   (§1.2 items 1–2); the pin installs only at packet 31.
2. Accept the `-compat` bundle size trade-off — **accepted**.
3. Record the desktop evidence (or designate who runs the procedure) — **open**;
   desktop/browser/gamepad items remain UNVERIFIED and roll into the final owner
   checklist. This does not block the contract promotion.
4. Confirm the strict-TS accommodation as a per-package additive `lib` entry —
   **accepted**.
## 2. Content storage, asset identities and migration (packet 15, approved)

**APPROVED 2026-09-18** (owner pre-approval; final manual review pending). Normative text:
`docs/planning/m2-contracts/content-storage.md` + `assets.md`; diffs
`diffs/{workspace,project-model}.md`; fixtures `fixtures/m2/contracts/{envelope,
catalog,migration,cases}/**`. Owner pre-approval (autonomous M2 build
instruction, 2026-09-18); final manual review pending.

Decisions (approved 2026-09-18, owner pre-approval; final manual review pending):

1. **Storage v2** adds exactly one bounded `content` block
   (`assets`/`prefabs`/`behaviors`/`settings`) to the same single-envelope
   `scenes/main.json`; `scene.revision` stays the sole revision; no second
   mutable catalog, no multi-file transaction.
2. **Bytes are immutable and content-addressed** under
   `sources/sha256/<digest>` (write-once, `O_NOFOLLOW`, verified on every read).
   `.thirdlight/{staging,derived}/**` are new non-authoritative sub-namespaces.
   Derived caches are regenerable offline at
   `<sourceDigest>/<recipeDigest>`, never a reference source.
3. **Asset identity** is an opaque `assetId`; a model component references the
   **whole GLB** by `assetId`; versions pin `sourceDigest` + `recipeDigest`;
   snapshot/play/export resolve to immutable versions. The M2 profile is glTF 2.0
   **GLB only**, embedded resources, bounded decoded metrics.
4. **Migration is explicit, non-destructive and operator-driven**
   (`migrateProjectCopy`): a new project identity, manifest stays v1, scene
   v1→v2 with verbatim entities, `storageVersion` 1→2, revision
   **reset-to-zero**, retry cleared, source project byte-retained; crashed
   destinations are resumed or deleted, never auto-completed.
5. **No M2 garbage collection**; superseded versions stay for undo/history/pins.
   Complete backup = manifest + envelope + **all** `sources/sha256/**`.
6. **Bounds** (must be pinned at Gate E; fixture-approved values):
   source/stage/upload 32 MiB per stage, frame 1 MiB, content block 1 MiB,
   catalog 128 assets / 32 versions each / 1 024 records, staging 8 open /
   128 MiB / TTL 3 600 s, project quota 512 MiB.

No M1 behavior changes; a `storageVersion 1` project loads and edits exactly as
accepted (acceptance A01).

## 3. Typed edits, prefabs and declared properties (packet 16, approved)

**APPROVED 2026-09-18** (owner pre-approval; final manual review pending). Normative text:
`docs/planning/m2-contracts/{prefabs,properties}.md`; diffs
`diffs/{commands,project-model}.md` (packet-16 additions); fixtures
`fixtures/m2/contracts/commands/**`.

Decisions (approved 2026-09-18, owner pre-approval; final manual review pending):

1. **Materialized copy-on-instantiation prefabs.** M2 definitions are immutable;
   instantiation remaps every local ID once and records the mapping durably; one
   transaction/one undo/one redo preserves identity; no nesting, variants,
   linked instances, apply/revert or automatic propagation.
2. **Declared properties** are data-only: stable keys, typed defaults and
   validation over `number | boolean | string | Vec3 | entityRef | assetRef`;
   no functions, no accessor execution, no schema discovery by evaluating code;
   unknown overrides are never silently dropped.
3. **New typed commands** (no JSON Patch/eval): `publishAsset`,
   `createPrefab`, `instantiatePrefab`, `setComponent`,
   `setBehaviorProperties`, `setSettings`, `publishBehavior` (declaration modes),
   plus bounded content queries. Each has `expectedRevision`/`requestId`, an
   inverse, no-change, retry, failure and projection semantics.
4. **Bounded queries** for assets/prefabs/behaviors; every field has a
   default/type/range; a declaration/source compatibility change cannot silently
   erase user data.
5. **`publishAsset` naming** resolves the packet-15 `createAssetVersion` label
   (`docs/planning/m2-contracts/contract-diffs.md` §3(a)).

## 4. Stateful runtime, input and 2.5D physics (packet 17, approved)

**APPROVED 2026-09-18** (owner pre-approval; final manual review pending). Normative text:
`docs/planning/m2-contracts/{input,physics,platformer}.md`; diffs
`diffs/{runtime,project-model}.md` (packet-17 additions); fixtures
`fixtures/m2/contracts/{input,physics,platformer,runtime}/**`.

Decisions (approved 2026-09-18, owner pre-approval; final manual review pending):

1. **Physics engine and distribution: `@dimforge/rapier2d-compat` at exactly
   0.20.0** — integrity
   `sha512-FFYwGrfJov7d5kn4fxblG/ip5C+sYQL+Jl/hqLvDvu4BcMD/Mhrz7cTvnZTtuIRDXY8CLuraObqB/prip4wdWQ==`,
   Apache-2.0 — kinematic character controller, parentless collider, XY-only
   collision. **This restates §1's provisional selection; the pin enters the
   lockfile only at packet 31 after Gate E.** The desktop evidence and the
   Gate E approval are still open (`delivery.md` §13).
2. **Step-indexed `ActionFrame`** (`moveX ∈ [-1,1]`, `jump`
   none/pressed/held/released; one sample per executed step, one press edge per
   step, quantization `1e-4`; keyboard A/D+arrows+Space, standard gamepad).
3. **Phase order** `intent → controller → physics → transform`, one transform
   owner, phase-scoped write guard, `SIM_HZ = 120`, `MAX_CATCHUP_STEPS = 8`,
   `SETTLE_PREROLL_STEPS = 12`.
4. **2.5D features** (exhaustive): static boxes + bounded convex polygons,
   one upright kinematic capsule player, no dynamic bodies/joints/sensors/
   mesh colliders/Z collision. Tolerances/defaults in `physics.md` §7 +
   `platformer.md` §7 (coyote 6, buffer 8, release ×0.5, gravity −19.62, run 4.0).
5. **Fail-stop** on any module/port error: no rollback of private state; retain
   the last completed render state; disposal + fresh restart only. Fixed static
   camera looking toward −Z.

## 5. Trusted behavior execution and compilation (packet 18, approved)

**APPROVED 2026-09-18** (owner pre-approval; final manual review pending); the trust disposition is recorded in the promotion record above.
Normative text: `docs/planning/m2-contracts/behaviors.md`; diffs
`diffs/{runtime,project-model,dependencies,export}.md` (packet-18 additions).

Decisions (approved 2026-09-18, owner pre-approval; final manual review pending):

1. **Trusted main-thread TypeScript behaviors** compiled without server-side
   execution; **no hard runtime timeout and no hostile-code sandbox**; the
   restriction set (static import checks, no `fetch`/`eval`/`import()`, no
   Node/backend imports) is defense in depth, not a sandbox. If a hard boundary
   is required, a separate execution-boundary design packet is the recorded path.
2. **Mandatory order** stage source/declaration → validate/compile → digest-bound
   prepared result → atomic `runCommand` publication. Public source publication
   stays **unavailable** until packet 33's preparation path; a compile failure
   never replaces a good publication; a later full-bundle build failure preserves
   the last successful artifact.
3. **Pinned module set** = `@thirdlight/runtime`, `@thirdlight/platformer`,
   `@thirdlight/physics-rapier` at locked versions + `three@0.186.0`; the
   compiler uses the already-pinned `esbuild@0.28.2` (no new pin, no lockfile
   change). `COMPILER_LIMITS`: files 16, fileBytes 65 536, graphBytes 262 144,
   importDepth 8, importsPerFile 16, diagnostics 32, timeoutMs 2 000,
   outputBytes 131 072.
4. **Bounded intent API** (`ctx.emit`) with an exhaustive validation order,
   duplicate-writer/limit failure semantics, a per-instance log ring and flood
   accounting; trust acknowledgment is a durable gate before first execution.

## 6. Delivery, protocol, export and dependency integration (packet 19, approved)

**APPROVED 2026-09-18** (owner pre-approval; final manual review pending). Normative text:
`docs/planning/m2-contracts/delivery.md` + `contract-diffs.md`; diffs
`diffs/{sessions,export,dependencies}.md` (packet-19 additions); fixtures
`fixtures/m2/contracts/delivery/**`.

Decisions (approved 2026-09-18, owner pre-approval; final manual review pending):

1. **Immutable runtime-content manifest** captured at one authoring revision
   (scene digest + resolved asset versions + behavior outputs + required engine
   modules + recipe/toolchain versions + build identity). `snapshotId`,
   `buildId` and `outputDigest` are distinct identities; **`project@revision` is
   never equated with an engine-independent binary hash**; build failure
   preserves the previous output.
2. **Authoring asset-byte reads** (`GET …/content/assets/:assetId/versions/:version/bytes`):
   authenticated, project-scoped, immutable-version, digest-verified, no paths,
   no staged files, no cross-project reads; the renderer receives bytes or an
   injected resolver and **no authoring token**.
3. **Preview delivery via a read-only play-content locator** (`contentId`, 32
   CSPRNG bytes, TTL 900 s + 60 s grace): completed immutable artifacts only,
   no authoring token, no `/api/v1`, no listing/traversal/cross-project access,
   redacted in logs, excluded from exports, immutable cache; a reload never
   resolves to newer bytes. Bridge **v2** keeps the exact origin/source/nonce
   checks and adds bounded load/input messages; no GLB bytes or compiled scripts
   in any WS state frame.
4. **Bounded input-exercise relay** (`POST …/play/:playSessionId/input`,
   step-indexed semantic actions, ≤ 600 frames, exclusive test mode cleared on
   completion/stop/disconnect, applied step range + `snapshotId`/`buildId`
   reported); no browser ⇒ the structured `session_unavailable`, never a
   simulated success.
5. **Snapping** (sessions.md §9): 0.25 m / 15° / 0.25 uniform scale
   (clamped 0.01–100), world-space deltas, round-half-away-from-zero then
   `1e-4` quantization, Shift disables for one gesture, local-preview only, no
   persistent setting, zero commands during drag, exactly one on release, none
   on cancel.
6. **Export** = the same runtime/module/build pipeline + the complete reachable
   closure (GLBs, behavior outputs, WASM if separately emitted), all relative to
   the output tree; no credentials, capability URLs, host paths, CDN, Node/server
   packages or backend requirement; engine fetches become allowlisted relative
   artifact reads (replacing M1's one-fetch rule **only** through the export
   diff); format-aware GLB/WASM validation + JS scans + browser network
   assertions; license notices and exact versions/hashes in `meta.json`.
7. **New units/edges/pins approved here (per diff, nothing installed):**
   `asset-pipeline`, `input`, `physics-rapier`, `platformer`, `behavior-build`
   (Node-side compiler; the browser behavior types live in `runtime`);
   `@dimforge/rapier2d-compat@0.20.0` (lockfile only at packet 31); **no new GLB
   pin** (the pinned `three@0.186.0` GLTFLoader subpath is used).
8. **U-4 disposition: ACCEPT both M1 requests** exactly as implemented
   fail-closed — optional `engineRoot` backend config + `THIRDLIGHT_ENGINE_ROOT`
   (sessions.md §13.7); the §5.4.1 reference-build entry
   `import * as THREE from 'three'; console.log(THREE.REVISION);` with the
   table counts unchanged. Gate C CF-2/CF-3 are the same two items and are
   disposed by this entry. Recorded under the owner pre-approval tag; final
   manual review pending — if rejected at Gate E, both stay fail-closed.
