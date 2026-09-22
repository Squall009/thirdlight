# Gate G review — asset/prefab/property/snapping authoring workflow (packets 26–28)

2026-09-19. Reviewer: this session (not the authors of packets 26–28, and not
the author of the Gate E/F records). No implementation, contract, decision,
fixture or tool was changed by this review; no packet was started. The verdict
is this record only — it is **not** a separate-reviewer approval, not owner
approval, and not a claim of browser verification. A contract change reopens
Gate E's affected portion per `docs/planning/m2-plan.md` §5.

## 1. Scope and method

Gate G covers packets 26–28 (shared GLB rendering/asset previews; content
browser, placement/reimport and snapping; prefab and declared-property
authoring UI) per `docs/planning/m2-plan.md` §5 ("asset/prefab/property/snapping
authoring workflow; real browser evidence and M1 regression") and the Gate
review prompt in `docs/planning/m2-packets.md` (Gate review prompt E–J).

Method: fresh reads of the accepted `docs/contracts/**` and decision 0002;
scoped review of the uncommitted packet 26–28 tree (file-level attribution by
mtime, since no M2 commit exists); execution of every required root check on
the current tree; independent re-derivation of the packet-26 ownership/no-network
claim (own esbuild-bundled probe, §3.2), the packet-27 snapping math against
`sessions.md` §9, the gesture command discipline, and the packet-28
copies-not-linked / one-copy-edit / reopen behavior; inspection of the
projection/transport path and of the browser procedures; adjudication of every
recorded contract-change request. Handoffs 26–28 were read as context only and
were not treated as proof.

**Tree state.** HEAD is `5b746ee` (Gate D FD-1 repair). All M2 work is
uncommitted. Packets 26–28 touched only: `packages/{three-adapter,editor}/**`,
`tools/check-boundaries.{mjs,test.mjs}`, `tests/browser/m2-{assets,prefabs}/**`,
`docs/acceptance/evidence-m2/{26,27,28}/**`, `docs/handoffs/{26,27,28}.md`
(verified by mtime ≥ 2026-09-19 05:10; the packet-26 scoped-diff transcript
agrees). No contract, decision, fixture, lockfile, backend, workspace,
commands, protocol, project-model, runtime or exporter file was touched by
26–28.

## 2. Executed by this review (raw results)

| Check | Result |
|---|---|
| `npm test` | **95 files / 1269 passed**, exit 0 (matches handoff 28) |
| `npm run typecheck` | exit 0 (all 11 packages) |
| `npm run check-deps` | `check-deps: OK` — all pins exact, no drift, no new dependency |
| `npm run check-boundaries` | `OK — 11 package(s), 215 source file(s), 781 specifier(s)`, exit 0 |
| `npm run build` | `build: done (4 built, 0 skipped)`, exit 0 |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | `check OK: 33 group(s) passed, 0 problem(s)`, exit 0 |
| `npx vitest run packages/three-adapter --reporter=verbose` | 6 files / **40 passed** |
| `npx vitest run packages/editor tests/browser/m2-assets tests/browser/m2-prefabs` | 14 files / **145 passed** |
| `npx vitest run packages/editor/src/session/snapping.test.ts` | **12 passed** |
| `npx vitest run tools/check-boundaries.test.mjs` | 1 file / **80 passed** (includes the new `external-subpath-forbidden` negative control) |
| `git diff --stat 5b746ee -- docs/contracts docs/decisions` | **7 files, +5235/−146** (see §2.1) |
| GLTFLoader in the generated editor bundle | `dist/editor/main.js` contains `GLTFLoader` ×37; `dist/preview/preview.js` ×0 (`https://` 90 vs 23) |
| Independent ownership/no-network probe (own esbuild bundle, §3.2) | aggregate **15/15, outstanding 0**; preview/prepare path completes with `fetch`/`XHR`/`WebSocket` stubbed to throw |

### 2.1 Contracts/decisions untouched by packets 26–28 — confirmed

The tracked diff vs `5b746ee` is exactly the post-Gate-F state: the Gate E
docs-only promotion recorded **+5077/−145**, and the GF-1/GF-2 repair added
**+158/−1** ⇒ **+5235/−146**, which is the current number. `docs/decisions` has
an empty tracked diff (decision 0002 is the new untracked promotion file, mtime
2026-09-19 02:00). Contract mtimes are 04:55–05:02 (GF-1/GF-2 window), **before**
packet 26's first evidence (05:19) and packet 27/28 evidence (05:41/05:57).
`gltf-loader`/`GLTFLoader` appear in `dependencies.md`/`project-model.md`/
decision 0002 only in text promoted by Gate E, not in a new packet-26 row. **No
additional contract or decision change is a finding.**

### 2.2 Reported but not independently re-run

The packet-26 "27 allocations / 27 releases / 0 outstanding" figure comes from a
**removed** disposable probe (`evidence-m2/26/raw/ownership-counters.txt`) — it
is not re-runnable. My own probe reproduces the *property* (balance, zero
outstanding, no network) through the public API with the real loader (§3.2),
and the committed `gltf-loader.test.ts` spies on real `geometry.dispose`/
`material.dispose` exactly once. The fake-port balance test
(`visual-resource.test.ts`) proves the ledger arithmetic, not GPU disposal.

## 3. Independent re-derivation

### 3.1 Snapping math vs `sessions.md` §9 (recomputed)

§9 (lines 450–462): `snapped = clamp(round(value / increment) * increment)`,
round-half-away-from-zero, then quantized to `1e-4`; translate 0.25 m per world
axis on the **delta**; rotate 15° about the gizmo axis, quaternion rebuilt and
re-normalized; scale 0.25 on the uniform factor clamped `[0.01, 100]`; Shift
disables one gesture; zero commands on drag / one on release / none on cancel.

Recomputed by hand and matched the code/tests:

- `snapValue(0.125, 0.25)`: 0.125/0.25 = 0.5 → half-away = 1 → 0.25 → quantized
  0.25 ✓; `snapValue(-0.125, 0.25)` = −0.25 ✓; `snapValue(0.375, 0.25)` = 0.5 ✓.
- `snapRotationAngle(7.5°, [0,1,0])`: 7.5/15 = 0.5 → 1 → 15° → quantize 0.2618 ✓;
  `(30°)` → 0.5236 ✓; `(−7.5°)` → −0.2618 ✓; `0.01 rad` → 0 ✓.
- `snapScaleFactor(0.124)` = clamp(round(0.124/0.25)·0.25) = clamp(0) = 0.01 ✓;
  `100.3` → clamp(100.25) = 100 ✓; `0.6` → 0.5 ✓; `−5`/NaN/±Inf → 0.01 ✓.
- Cancel and no-op: `Gesture.cancel()` sets `cancelled`, reverts the preview, and
  `decideCommit()` returns `noop`; `GestureRunner.cancel()` issues nothing. A
  drag that ends at base is `noop` (correct: a no-op `setTransform` would be
  `no_change`).

**Verdict: the packet-27 snapping contradicts nothing; math is exact.** One
contract/implementation mismatch remains — C27-2 (rotational axis), adjudicated
in §5.

### 3.2 Packet-26 ownership/disposal + no-network (own probe)

`/tmp/gateg-probe/probe.ts` (esbuild-bundled, real `three@0.186.0` GLTFLoader,
`buildGlb()` bytes) through the public API: 3 load/reimport/dispose rounds,
instance + preview controller each round, then `store.dispose()` ⇒ aggregate
`15/15, outstanding 0` (geometry 3/3, material 6/6, mixer 3/3, instance 3/3; no
textures because the byte fixture embeds none); live-resource outstanding 5
before teardown; with `fetch`/`XMLHttpRequest`/`WebSocket` replaced by throwing
stubs, `prepare → createInstance → play → update` succeed and release to
outstanding 0. Commit test `gltf-loader.test.ts` independently proves exactly
one real `geometry.dispose()`/`material.dispose()` per resource and zero double
release. **The packet-26 ownership/disposal and no-network claims hold.**

### 3.3 Gesture command discipline (raw tests)

`gesture-snap.test.ts` + `tests/browser/m2-assets/authoring-flow.test.ts`
executed: 50 per-frame previews ⇒ 0 commands; release ⇒ exactly 1 (carrying
`expectedRevision` = drag-start revision); cancel ⇒ 0 and preview reverted;
one undo restores the pre-gesture transform; a conflict auto-rebases **once**
(≤ 2 issued total, second at the new revision) then surfaces. The React app does
**not** use `GestureRunner` (it uses `Gesture` directly in `onGestureEnd`,
issuing the one command itself; handoff 27's "the React app uses it with a
client-backed sink" is inaccurate but behaviorally equivalent).

### 3.4 Packet-28 copies-not-linked / one-copy edit / reopen

`tests/browser/m2-prefabs/prefab-authoring-flow.test.ts` (12 tests) replays the
**accepted** `fixtures/m2/contracts/commands/prefab-scenario.after.json` and
`fixtures/m2/prefabs/independence.messages.json` through the real
`Projection`/`PrefabProjection`: two copies with distinct IDs/transforms; I2
edits copy A (`speed 1.25`) while copy B keeps the definition value (`4.5`); a
`publishBehavior` declaration update moves the declaration default (99) without
rewriting any copy; `removePrefab` removes only the definition; one undo removes
the whole second subtree and redo restores the exact IDs; an MCP-origin
`mutation.applied` converges with the M1 dedup/gap rules. The projection's
`instantiatePrefab`/`setComponent`/`setBehaviorProperties` branches are
additive and read the change payloads. `derivePropertyControls`/`collider`/
`controller` views are built from declaration data only (no `eval`/`new
Function`/dynamic import; source-scan test). **Verified.**

Nuance: the "reopen-from-queries" test re-hydrates from the same JSON fixture; it
does not exercise `client.fullResync()`'s new `queryPrefabs`/`queryBehaviors`
reads (browser transport, untested in Node). The client code path is present
(`client.ts:302–330`) but is **reported, not executed**.

## 4. Findings (prioritized, concrete)

**P1-1 — C27-1: no accepted command can create a `components.model` entity
(milestone-blocking scope gap).**
`commands.md` §3.1/§8.1 restrict `createEntity` to `{group, box}`; §8.10 requires
`setComponent`'s target to already carry the component (`component_missing`) and
its non-goal says "no component add/remove in M2" (line 1312); `createPrefab`
(§8.6) only captures an existing subtree. Yet §5.4's `id_exhaustion` row and
§8.1 step 4 already define the derived `model` kind/prefix, and §8.10 says
`model` presence "is created by placement/instantiation" — an operation that
does not exist. Consequence: m2-plan §1's outcome "place it in a scene" and
acceptance A02/A03 ("place two instances") cannot be authored through the
command path; packet 27 correctly reports `placement_unavailable`
(`session/placement.ts`) rather than faking it. See §5 for the required diff.

**P1-2 — C28-1: no accepted command creates or edits
`components.collider`/`components.controller` (milestone-blocking scope gap).**
`commands.md` §8.10 owns only `box`/`camera`/`model`. The model defines both
components (project-model §10.7/§10.8/§21) and the packet-28 public surface
requires "schema-driven controls for … collider/controller properties", but the
shipped controls are read-only contract-shape views. Consequence: acceptance
A12 and journey step 5 ("configure the character/test course through supported
commands/inspector") cannot be authored. See §5 for the required diff.

**P2-1 — `ModelInstances.previewAsset` leaks a superseded in-flight preview
(resource disposal, browser-only path).**
`packages/editor/src/viewport/model-instances.ts:176–214`: a second
`previewAsset()` while the first is still loading disposes `this.preview`
(still `null`) and starts a second load; when the first resolves it sets
`this.preview` unconditionally, and the second then overwrites it. The first
session's instance/controller/holder are added to the scene and never disposed
until `dispose()` (which only handles the surviving session). Minimal repair:
generation token; discard a stale resolution (dispose it) exactly as the visual
store does for stale loads; add a Node test with the injected resolver. Bounded;
not observable in-container.

**P2-2 — evidence labeling overstates two packet-27/28 claims (reporting, not
code).**
(a) `evidence-m2/27/manifest.md` row 1 labels "Import → preview → place twice" as
Node-verified; the test's two placements are `instantiatePrefab` copies of a
**pre-seeded** `prefab-0001`, not placements of the imported asset (which the
same suite separately asserts is `placement_unavailable`). The handoff 27 is
honest; the manifest is what packet 37 will cite. (b) "reopen from queries" is
re-hydration from static JSON, not `fullResync`. Both should be reworded when
GG-1 lands.

**P3-1 — C26-2: `export.md` §5.4.1 binding 4 conflicts with the intended
packets-35/36 bundle graph.**
Binding 4 fixes the export/preview `https://` count at the pinned-three value
(23); the package-26 measurement (`raw/export-bundle-counts.txt`) shows adding
the GLTFLoader subpath yields 35 (Δ +12). I re-measured the current bundles:
`dist/preview/preview.js` is still loader-free (`https://` 23) and
`dist/editor/main.js` (no binding) is 90. The conflict is real and will fail
packets 35/36 scans unless the exception table is extended.

**P3-2 — C27-2: rotate snapping applies two axes while §9 says "the gizmo
axis".**
`gizmo.ts` applies accumulated yaw about +Y and pitch about +X, each snapped to
15° and the composed quaternion re-normalized; §9 names a single gizmo axis, and
the drawn helper is a single Y ring. Non-blocking, but the contract text and the
visual affordance both need reconciling.

**P3-3 — M1 gizmo drag semantics changed by packet 27.**
`gizmo.pointerMove` changed from per-event delta to accumulated delta (a real
fix: the M1 code kept only the last frame's delta), and rotate now re-normalizes.
No M1 test covers the gizmo (browser-only) and Gate C/D left it visually
unverified; record this as an M1 behavior change to re-check in the packet-37
walkthrough.

**P3-4 — `ModelInstances.loadAsset` retries a persistently failing asset on
every `sync`.** A failed load deletes it from `loading` and stores a failure;
the next projection update re-issues the load. Bounded but potentially chatty
for a missing/corrupt asset; a backoff/`failed` guard is the minimal repair.

**P3-5 — C26-1/C26-3/C26-4 informational.** `dependencies.md` §3's
`three-adapter` row names the helpers but not the `./gltf-loader` subpath (the
code and `package.json` export it; §4.2 prose acknowledges it). The M2
extension allowlist is duplicated defensively because `three-adapter →
asset-pipeline` is forbidden. `Object3D.clone(true)` shares skeletons (no M2
fixture has a skin), so per-instance skeletal animation is not claimed.

## 5. Contract-change adjudication (packets 26–28)

Legend: **A** accept as recorded; **A+D** accept with the diff below; **R**
reject. "Reopens" lists the Gate E portion that must be re-promoted/re-accepted.

| Item | Decision | Diff / rationale | Reopens (Gate E portion) | Required by |
|---|---|---|---|---|
| **C26-1** `./gltf-loader` subpath row | **A+D** | Add to `dependencies.md` §3 `three-adapter` row: the `./gltf-loader` subpath export (`createGltfLoaderPort`, allowed-extension constants) and the rule that the root subpath stays loader-free. Code already conforms. | dependencies.md §3 (three-adapter addition) | next docs repair; not gating 29 |
| **C26-2** export §5.4.1 binding 4 vs GLTFLoader | **A+D** | Extend the §5.4.1 version-bound table with a measured GLTFLoader row (`https://` +12 → 35, `GLTFLoader` ×37, bytes 2 137 831 measured 2026-09-19 under the pinned flags) and restate binding 4 as "core counts + the loader row when the graph includes the subpath"; identity/flags/reference-build conditions unchanged. | export.md §5.4.1 (+dependencies §5 check 4) | **before packets 35/36** (blocks their scans); not 29–32 |
| **C26-3** duplicated extension allowlist | **A** | Correct observation; `three-adapter → asset-pipeline` is a forbidden edge, so the defensive copy + injectable allowlist stays. Add one sentence to the dependencies §3 row requiring a single change point. | none | bounded note |
| **C26-4** `clone(true)` shares skeletons | **A** | Correct, bounded M2 non-goal (no M2 fixture carries a skin; `asset-pipeline` counts no skins; A12 excludes skeletal animation). Record the limitation in project-model §18.1/§20.4 notes and the packet-37 procedure; `SkeletonUtils.clone` is a future reviewed change. | none (note only) | bounded note |
| **C27-1** no command creates `components.model` | **A+D** | See §5.1. | **commands.md §2/§3.1/§5.4/§8.1** | **milestone-blocking**: before any A02/A03 placement claim; recommended before 29; mandatory before Gate J |
| **C27-2** rotate axis interpretation | **A+D** | Amend `sessions.md` §9's Rotate row to "each accumulated gizmo axis (yaw about +Y, pitch about +X), each snapped to 15° and the composed quaternion re-normalized"; make the rotate helper show both axes (or drop pitch) so the visual affordance matches. | **sessions.md §9 (Rotate row)** | before Gate J browser snapping evidence |
| **C28-1** no command creates/edits `collider`/`controller` | **A+D** | See §5.2. | **commands.md §2/§3.1.6/§5.4/§8.10/§5.3/§9.1** | **milestone-blocking**: before packets 30–32 acceptance/Gate H and mandatory before packet 37 journey step 5 |

**Totals: 7 adjudicated — 2 accept as recorded, 5 accept-with-diff, 0 rejected.**
Two are milestone-blocking (C27-1, C28-1); one is a future packet blocker
(C26-2, packets 35/36). No request hides a silent implementation deviation: the
implementations correctly refused to fabricate the missing operations.

### 5.1 Minimal accepted diff — C27-1 (place an imported GLB)

Extend `createEntity` (no new op; reuses the accepted ID allocation, dedup,
inverse, change and pipeline):

- `commands.md` §2 table: effect becomes "Append one new entity (`group`, `box`
  or `model`)"; model carries a resolving whole-GLB reference.
- §3.1 `createEntity` table: `kind` ∈ `"group" | "box" | "model"`; add `model`
  (`{ "asset": { "assetId": <existing `content.assets` record> } }`), **only
  when `kind` is `"model"`**; `box` only when `kind` is `"box"`.
- §8.1 step 1: preconditions `kind ∈ {group, box, model}`; a model kind requires
  the asset reference to resolve, else the project-model scene code
  `asset_reference_missing` (add that code to §5.4 — it is already emitted by
  project-model but has no commands.md row).
- §8.1 step 2: the ID prefix is the derived kind (`group`/`box`/`model`), which
  §5.4/§8.1 step 4 already define; no other ID rule changes.
- §8.1 step 6 camera-count note stays valid.
- `change.type = "createEntity"` with the full entity and the existing `delete`
  inverse already cover the undo path.

Owning repair scope: contracts `commands.md` (§2, §3.1, §5.4, §8.1, §9.1
inverse list unchanged); `packages/commands` (arg validation + create-entity
application); `packages/protocol` (op arg union/validator); `packages/editor`
(`session/placement.ts` `planAssetPlacement` → plan `createEntity` + transform;
enable the Place control in `ui/App.tsx`/`AssetBrowser.tsx`; `projection.ts`
already maps `model`); fixtures/tests
`fixtures/m2/contracts/commands/**` + `fixtures/m2/commands/**` (new byte-exact
scenario + errors), `packages/commands/src/m2-*.test.ts`,
`tests/browser/m2-assets/authoring-flow.test.ts` (place the imported asset
directly; replace the `placement_unavailable` assertion), the packet-27 browser
procedure and manifest.

Alternative (owner/contract author to pick **one**, not both): allow
`setComponent` to add `model` on an existing entity. That closes C27-1 with the
same diff as C28-1 but yields `group-`/`box-` prefixed model entities and two
revisions per placement. The `createEntity` route is recommended because §5.4
and §8.1 step 4 already describe the derived `model` prefix.

### 5.2 Minimal accepted diff — C28-1 (author collider/controller)

Extend `setComponent` so the two physics components can be **added, edited and
removed** on an existing entity (no second op; reuses the §6.1 pipeline, the
`setComponent` inverse kind and change type):

- §2 table and §3.1.6: `component ∈ {box, camera, model, collider, controller}`.
- §8.10: keep partial **edit** semantics for `box`/`camera`/`model`; for
  `collider`/`controller` allow **add** when the entity does not carry the
  component (`value` non-empty; `component_missing` no longer raised) and
  **remove** via `value: null`. Validate with project-model §10.7/§10.8/§21
  (`collider_shape_invalid`, `controller_count_invalid`,
  `physics_transform_unsupported`; the `colliders`/`collider_vertices*` limits
  already exist in §5.4). Amend the §8.10 non-goal line 1312 to "no add/remove
  for `box`/`camera`/`model`".
- §5.3 change data: `previous`/`next` become `unknown | null` (null = absent).
- §9.1 inverse: `{ kind: 'setComponent', id, component, restore: previous | null }`
  (undo of an add removes; undo of a remove restores).

Owning repair scope: contracts `commands.md` (§2, §3.1.6, §5.3, §5.4, §8.10,
§9.1); `packages/commands` (validation/app/inverse; component set); `packages/
protocol` (arg union); `packages/editor`
(`session/property-controls.ts` collider/controller controls become editable,
`ui/Inspector.tsx`/`PropertyControls.tsx`, `projection.ts` already carries
`collider`/`controller`); fixtures/tests `fixtures/m2/contracts/commands/**` +
`fixtures/m2/commands/**` (add/edit/remove collider; add controller; error
cases), `packages/commands` tests, the packet-28 Node + browser procedures.
Physics components are stored in the scene document, so no workspace/backend
change is expected beyond the existing command pipeline.

This reopens the Gate E commands.md portions named above; they are re-accepted
as of the repair.

## 6. Real-browser assessment (honest)

No approved browser harness exists in the container: no Playwright/npm browser
dependency is installed (U-5 remains open: "no automatic install"), and every
prior M2 packet recorded the same constraint. (A Playwright chromium binary
cache does exist at `/home/dadmin/.cache/ms-playwright/chromium-1234/`, but no
package or approved automation path uses it; this review did not run it and
does not treat it as evidence.) The packet-37 manual procedures
(`tests/browser/m2-assets/m2-assets.browser.ts`,
`tests/browser/m2-prefabs/m2-prefabs.browser.ts`) are **sufficient and honest**:
they name OS/browser/WebGL, real PNGs, network recording, MCP convergence,
context loss and disposal, and they state explicitly that nothing is verified.
They must be updated when GG-1/GG-2 land (direct placement; editable physics
controls) and when a real browser/automation is approved.

**UNVERIFIED (cannot be claimed from this container):** rendered pixels and PBR
materials; embedded PNG/JPEG texture decode; `toDataURL` screenshot taint;
`webglcontextlost`/`restored` round trip and re-upload; viewport play/pause/scrub
poses; gizmo snapping preview/steps and real network capture (zero on drag, one
on release, none on Esc); prefab capture/copy/override pixels; MCP-origin paint
convergence without reload; panel layout/screenshots; `renderer.info.memory`
stability.

## 7. Blockers vs bounded follow-ups

**Milestone-blocking contract repairs (required; a separate repair step, not
auto-started):**

- **GG-1 (C27-1)** — the §5.1 diff + its commands/protocol/editor/fixture/test
  scope. Required before any A02/A03 placement claim and before the milestone
  outcome; recommended before packet 29 (it changes the command set the editor
  and later packets consume); mandatory before Gate J.
- **GG-2 (C28-1)** — the §5.2 diff + its scope. Required before packets 30–32
  acceptance / Gate H (course/controller authoring) and mandatory before packet
  37 journey step 5; recommended in the same step as GG-1.
- **GG-3 (C26-2)** — the export §5.4.1 exception-table diff. Required before
  packets 35/36 (their bundle scans will otherwise fail); not 29–32.

**Bounded follow-ups (non-blocking):**

- **GG-4 (P2-1)** `model-instances.ts` stale-preview disposal + a Node test.
- **GG-5 (P2-2)** correct the packet-27 manifest's A02 "place twice" row and the
  "reopen from queries" wording (and handoff 27's `GestureRunner` sentence).
- **GG-6 (C26-1/P3-5)** add the `./gltf-loader` subpath row to
  `dependencies.md` §3; note the duplicated allowlist and the skeleton limitation.
- **GG-7 (C27-2/P3-2)** amend `sessions.md` §9's Rotate row and the gizmo helper
  affordance.
- **GG-8 (P3-4)** guard repeated failed asset loads in `model-instances.ts`.
- **GG-9 (P3-3)** re-check the changed M1 gizmo drag semantics in the packet-37
  walkthrough (no M1 test covers the gizmo).

**Blockers: none for packet 29.** Runtime scheduling/lifecycle (packet 29) does
not depend on the model-placement or collider/controller command surface; Gate G
is accepted with the bounded repairs above, so 29 may start. GG-1/GG-2 must be
applied before the dependent packets/Gate H and Gate J acceptance.

## 8. Missing context / unverified targets

- No browser/WebGL/pixel/network evidence exists (U-1 residual); see §6.
- Physics selection stays PROVISIONAL; desktop/gamepad and CPU figures are
  container/directional (BR-2, decision 0002 §1.1) — out of Gate G scope.
- The trusted-main-thread script boundary is owner-pre-approved pending final
  manual review; packets 26–28 do not execute project scripts and packet 28
  derives controls from declaration data only.
- `client.fullResync`'s new prefab/behavior queries are browser-transport code
  exercised only by the packet-37 procedure, not by a Node test.
- The packet-26 removed ownership probe is not re-runnable; §3.2 and the
  committed real-loader tests reproduce the property.
- Only process-`SIGKILL`-level durability was established at Gate F; power-loss
  durability remains unproven (out of scope here).
- `docs/decisions/0002` final manual owner review is still pending.

## 9. Verdict and next step

**ACCEPT WITH BOUNDED FOLLOW-UPS.** The implemented packets are architecturally
sound: one three-adapter resource-owner path (real loader, ownership balance,
idempotent disposal, no network), one command/projection path in the editor
(pure, Node-verified), the exact snapping table and command discipline, and
additive transport/projection changes with byte-unchanged M1 fixtures; all
required checks are green on the current tree; the contracts/decisions are
untouched by 26–28 and the two milestone-blocking gaps are contract gaps the
implementations correctly refused to fake. **A02/A03 "place two instances",
A12 course configuration and journey step 5 remain UNMET until GG-1/GG-2 are
applied; browser evidence remains UNVERIFIED.** This verdict is not a separate
reviewer's approval.

**Exact next step:** a bounded repair step applying **GG-1/GG-2** (the §5.1/§5.2
contract diffs plus their commands/protocol/editor/fixture/test scope) and
**GG-3** (export §5.4.1), recording GG-4…GG-9 dispositions, then re-accept the
reopened Gate E portions — then packet 29. Do not start any packet
automatically.
