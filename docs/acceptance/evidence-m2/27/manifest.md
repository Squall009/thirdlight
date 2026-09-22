# Packet 27 evidence — content browser, placement/reimport and snapping

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.** No git commit was made.

Raw outputs in `raw/` are literal command transcripts. No browser exists in this
container: every browser/WebGL/pixel claim is listed as **UNVERIFIED** with the
packet-37 manual procedure (`tests/browser/m2-assets/m2-assets.browser.ts`,
reproduced below).

## Scope

`packages/editor` gains the packet-27 authoring path:

- pure, Node-testable modules: `session/snapping.ts` (the contract's exact
  increments/rounding/clamps), an extended `session/gesture.ts` (snapping
  preview, explicit cancel, `GestureRunner` command discipline), an additive
  `session/content-projection.ts` (the asset catalog projection), a pure
  `session/asset-browser.ts` (drop validation, bounded frame/job/import flow,
  stale/late-result handling, `publishAsset` args from the proposal) and
  `session/placement.ts` (typed whole-model placement planning);
- browser transport additions in `session/client.ts` (bounded `queryAssets`,
  the content stage/frame/inspect/job/discard routes, the authenticated
  committed asset-byte read, `publishAsset` through the same command path);
- the packet-26 consumer: `viewport/model-instances.ts` (one shared GLB
  resource path via `@thirdlight/three-adapter` + its `./gltf-loader` subpath
  with the injected authenticated resolver), the gizmo's accumulated drag +
  local snapping, viewport model placeholders/selection, and the React
  `ui/AssetBrowser.tsx` panel wired in `ui/App.tsx`.

No accepted contract, fixture, lockfile, `node_modules`, backend, workspace,
commands, protocol or three-adapter source was changed. The new editor
`package.json` exports are additive subpaths for the pure modules.

## Commands run and actual results

| Command | Result | Transcript |
|---|---|---|
| `npm test` | 91 files / **1216 passed** (exit 0) — was 85/1161 | `raw/npm-test.txt` |
| `npx vitest run packages/editor` | 9 files / **86 passed** (exit 0) | `raw/editor-verbose.txt` |
| `npx vitest run tests/browser/m2-assets` | 1 file / **6 passed** (exit 0) | `raw/m2-assets-tests.txt` |
| `npx vitest run packages/editor/src/session/snapping.test.ts` | 12 passed (exit 0) | `raw/snapping-tests.txt` |
| `npm run typecheck` | exit 0, all 11 packages | `raw/npm-typecheck.txt` |
| `npm run check-deps` | exit 0, all pins exact, no drift, no new declared dependency | `raw/npm-check-deps.txt` |
| `npm run check-boundaries` | exit 0 — 11 packages, 207 files, **746 specifiers**, no violations | `raw/npm-check-boundaries.txt` |
| `npm run build` | `build: done (4 built, 0 skipped)` exit 0 | `raw/npm-build.txt` |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | `check OK: 33 check group(s) passed, 0 problem(s)` (exit 0) | `raw/check-fixtures.txt` |

M1 regression: `packages/editor` M1 suites (`projection`, `gesture`, `envelope`,
`bridge`) are unchanged and green inside the 86 passing tests; the M1
`Gesture` API is extended (options argument, `preview`/`cancel`/
`commandDecisions`) without changing the existing constructor/semantics.

## Snapping increment table verified against the accepted contract

`docs/contracts/sessions.md` §9 lines 455–461 are quoted verbatim in
`raw/contract-snapping-lines.txt`; `raw/snapping-tests.txt` is the test run that
asserts, mechanically:

| Contract (sessions.md §9) | Code (`session/snapping.ts`) | Test |
|---|---|---|
| `SNAP_TRANSLATE_M = 0.25 m`, per **world axis**, **delta** snapped | `SNAP_TRANSLATE_M = 0.25`; `snapTranslateDelta` | snapping.test.ts translate |
| `SNAP_ROTATE_DEG = 15°` about the gizmo axis, rebuilt + re-normalized | `SNAP_ROTATE_DEG = 15`; `snapRotationAngle` | snapping.test.ts rotate |
| `SNAP_SCALE = 0.25` on the uniform factor, clamped `[0.01, 100]` | `snapScaleFactor` / `snapScaleFromBase` | snapping.test.ts scale |
| `round-half-away-from-zero`, quantized `1e-4` | `roundHalfAwayFromZero` / `quantize` | snapping.test.ts rounding |
| no parent/local-space snapping | world-space inputs only | gesture-snap.test.ts `applyRawGesture` |
| Shift disables for one gesture, no persistent setting | `snapActive(enabled, shiftKey)` | snapping.test.ts Shift |
| zero commands during drag / one on release / none on cancel | `Gesture.commandDecisions`, `GestureRunner` | gesture-snap.test.ts |
| one undo restores the pre-gesture transform | host undo stack over the single commit | gesture-snap.test.ts |

The contract text is also asserted from the file itself by
`tests/browser/m2-assets/authoring-flow.test.ts` (it reads
`docs/contracts/sessions.md` and fails if those §9 strings change), so the table
and the code cannot drift apart silently.

## Acceptance criteria

| Criterion | Status |
|---|---|
| Import → preview → place twice → reimport updates references without entity-ID/transform changes | **Node-verified** at the pure layer (`tests/browser/m2-assets`): import flow, two placements with distinct IDs and independent transforms, reimport moves `currentVersion` while the placement projection is byte-identical. **Correction (GG-5, 2026-09-19):** the original packet-27 suite's two placements were `instantiatePrefab` copies of a pre-seeded prefab and it separately asserted that direct asset placement was `placement_unavailable`; the row must therefore not be read as direct-asset placement. After the GG-1 repair the suite places the imported asset directly twice via `createEntity kind:"model"`, and the prefab-copy path is covered separately. **Browser pixels UNVERIFIED.** |
| Failure preserves old content | **Node-verified**: a failed/stale import never calls `ContentProjection.applyChange`, and only an applied `publishAsset` change moves the catalog. |
| Translate/rotate/scale snapping use the approved increments | **Node-verified** (table above). Browser preview/commit UNVERIFIED. |
| Zero commands during drag, exactly one on release, one undo; cancellation sends none | **Node-verified** with a counting command sink; browser network recording UNVERIFIED. |
| No decorative or graph UI | Met by construction: one list/job/status panel, no graph/dashboard views. Visual check UNVERIFIED. |
| Stale-job/conflict/reconnect/remote-edit-during-drag | **Node-verified**: stale/expired/late job ⇒ proposal cleared, not publishable; remote edit mid-drag keeps the base revision, one bounded rebase, then a surfaced conflict. Reconnect uses the M1 gap rule unchanged. |
| Invalid drop | **Node-verified**: non-`.glb`, empty and > 32 MiB are rejected before any stage/job; no state change. |

## Browser-UNVERIFIED list (packet-37 procedure)

1. Real GLB realization/reimport rendering in the editor viewport (mesh +
   materials + texture decode) and the WebGL context.
2. Asset preview play/pause/scrub visible pose on a real animation clip.
3. The Assets panel layout/pixels and the snapping toggle's appearance.
4. Real network recording proving zero requests during a drag and exactly one
   `setTransform` on release (plus none on Esc), and the bounded content route
   sequence on import/reimport.
5. Gizmo rotate batching: M1's rotate is a two-axis arcball-lite gesture, so the
   contract's "about the gizmo axis" is applied per accumulated axis (yaw about
   +Y, pitch about +X), each snapped to 15° and renormalized. Recorded as
   **C27-2** in the handoff for confirmation at Gate G/37.

Procedure: `tests/browser/m2-assets/m2-assets.browser.ts` (not run by vitest).

## Limitations / contract-change requests

- **C27-1 (blocking for direct asset placement).** No accepted M2 command can
  create a `components.model` entity from an `assetId`: `createEntity` accepts
  `kind ∈ {group, box}` (commands.md §3.1/§8.1), `setComponent` requires the
  component to already exist (§8.10, `component_missing`) and M2 has no
  component add/remove, and `createPrefab` captures an existing subtree (§8.6).
  `setComponent`'s own non-goal text says `model` presence "is created by
  placement/instantiation", but the placement operation is absent from the
  accepted contract. Proposed minimal diff: extend `commands.md` §3.1/§8.1
  `createEntity` with `kind: "model"` and `model: { asset: { assetId } }` (the
  asset must resolve; `id_exhaustion` kind `model` already exists), which reuses
  the accepted ID allocation and needs no new op. Until then
  `session/placement.ts` reports `placement_unavailable` structurally and the
  Place control is disabled — no fabricated command, no direct state write.
  Whole-model placement **is** available through the contracted
  `instantiatePrefab` (prefab copies), which the module plans.

  **Repair note (GG-1, 2026-09-19):** C27-1 is closed. `commands.md` §2/§3.1/
  §5.4/§8.1 now accept `createEntity kind:"model"` with a resolving
  `model.asset.assetId`; `session/placement.ts` plans a real `createEntity` and
  the Place control is enabled. This historical paragraph is retained as the
  record of what the packet-27 build did before the repair.
- C27-2 (rotate axis interpretation, non-blocking, above).
- `ui/App.tsx` now calls `viewport.syncEntities(entities)`; the M1 app never
  pushed the projection into the viewport, so no projection entity was
  previously rendered. This is a required correctness fix for placement
  visibility, not a behavior redesign.
