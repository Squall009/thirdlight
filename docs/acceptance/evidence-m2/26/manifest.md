# Packet 26 evidence — shared GLB rendering and asset previews

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.** No git commit was made.

Raw outputs in `raw/` are literal command transcripts. Nothing below is
reconstructed from memory, and no browser/WebGL/pixel evidence exists in this
container: every browser-only claim is listed as UNVERIFIED with the packet-37
procedure.

## Scope

`packages/three-adapter` gains the packet-26 realization path (root subpath,
loader-free): an approved asset-byte resolver accepting **bytes or an injected
async resolver** (never a token/URL/fetch), cancellable async prepared visual
resources with stale-completion discarding, whole-GLB model instances with a
preserved internal hierarchy and independent transform/animation state, a local
material/animation preview controller, explicit ownership counters and
idempotent disposal. The pinned `three@0.186.0` GLTFLoader binding lives on the
new `@thirdlight/three-adapter/gltf-loader` subpath. `tools/check-boundaries.mjs`
restricts `three-adapter` to the approved `three` root + GLTFLoader subpath.
No accepted contract, fixture, lockfile, `node_modules`, editor, backend,
workspace, protocol or exporter source was changed. **No editor viewport code
was added:** the M1 projection type (`ProjectedEntity`) has no model kind yet,
so a viewport attachment would be unwired placeholder code; packet 27 (content
browser/placement) consumes these public helpers instead. The packet's optional
focused editor integration is therefore deferred with that reason recorded.
`packages/editor/**` is untouched.

## Commands run and actual results

| Command | Result | Transcript |
|---|---|---|
| `npm test` | 85 files / **1161 passed** (exit 0) | `raw/npm-test.txt` |
| `npx vitest run packages/three-adapter --reporter=verbose` | 6 files / **40 passed** (12 before packet 26) | `raw/three-adapter-verbose.txt` |
| `npm run typecheck` | exit 0, all 11 packages | `raw/npm-typecheck.txt` |
| `npm run check-deps` | exit 0, all pins exact, no drift, no new declared dependency | `raw/npm-check-deps.txt` |
| `npm run check-boundaries` | exit 0 — 11 packages, 196 files, **710 specifiers**, no violations | `raw/npm-check-boundaries.txt` |
| `npm run build` | `build: done (4 built, 0 skipped)` exit 0 (editor/preview/mcp/backend) | `raw/npm-build.txt` |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | `check OK: 33 check group(s) passed, 0 problem(s)` | `raw/check-fixtures.txt` |
| boundary negative probe (disposable import of `three/examples/jsm/controls/OrbitControls.js`) | FAIL `external-subpath-forbidden`, exit 1; after removal: OK | `raw/boundary-negative-probe.txt` |
| GLTFLoader identity/API capture | three 0.186.0, `GLTFLoader.js` sha256 `131c0f78…`, `parse`/`parseAsync` surface | `raw/gltfloader-binding.txt` |
| ownership probe (disposable test, removed) | 27 allocations / 27 releases / 0 outstanding across 3 load+reimport+dispose cycles; per-kind tables | `raw/ownership-counters.txt` |
| export-bundle pattern measurement (disposable probe, removed) | real bundle: `https://` 23, `GLTFLoader` 0; +loader: `https://` 35 (Δ +12), 146 086 bytes — see C26-2 | `raw/export-bundle-counts.txt` |
| scope capture | only the packet's files | `raw/scoped-diff.txt` |

New suites (28 tests): `visual-resource.test.ts` 13 (resolver/bytes, cancellation,
stale discard, missing/corrupt/invalid-image/invalid-clip/unsupported-extension
mapping, two-instance independence, ownership balance, idempotent double
dispose, no-network), `preview-controller.test.ts` 6, `gltf-loader.test.ts` 6,
`context-loss.test.ts` 3. The boundary suite gained one test
(`external-subpath-forbidden`). The M1 suites `adapter.test.ts` (8) and
`sync.test.ts` (4) are byte-unchanged and still pass.

## Node-verified (with real three.js objects and the real pinned GLTFLoader)

- **Real loader binding.** `gltf-loader.test.ts` feeds self-generated GLB bytes
  (`test-glb.ts`) through the pinned `GLTFLoader` in Node and asserts a real
  scene graph: `Group 'Scene' → 'Main' → 'Rotor' → Mesh 'Tri'`,
  `MeshStandardMaterial` (colour-managed `baseColorFactor`), `BufferGeometry`,
  and clip `Spin` (1 track). No loader mock is involved.
- **Whole-GLB instances.** Two instances preserve the GLB hierarchy under one
  entity `Group`; geometry/material are the SAME objects (one owner), the
  instance objects and transforms are not (`root.position.x` 4 vs 0), and
  animation state is independent (one mixer at 0.5 s, the other at 0).
- **Play/pause/scrub.** The mixer applies the pose: scrubbing to the clip end
  moves the instance's `Rotor` quaternion (`z > 0.6`), scrubbing to 0 restores
  identity, scrubbing past the duration clamps. `pause()` freezes the clock,
  `update(dt)` advances only while playing, and a model without clips refuses
  `play`/`scrub` with `preview_invalid`.
- **Failures.** Cancelled resolver (`asset_load_cancelled`, AbortSignal observed),
  late completion after cancel (result discarded, loader result disposed exactly
  once, ledger balanced), missing (`asset_missing`), length-mismatch and
  loader-rejected containers (`asset_corrupt`), `asset_extension_unsupported`
  (guard on `extensionsUsed`/`extensionsRequired`), `asset_image_invalid`
  (loader-port reason; in Node the real loader's embedded-image decode also
  fails structurally), `asset_clip_invalid` (bounded track/duration validation
  — note: three stores key times in a typed array, so validation accepts
  `Float32Array`), no failure crosses the module edge as a throw, messages ≤ 256.
- **Resource ownership.** Loader-created geometry/material/texture are counted
  by the port and disposed through the resource (`vi.spyOn` proves exactly one
  call each; double `dispose()` adds none). Aggregate over 3 load/reimport/dispose
  cycles: 27/27/0 with per-kind balance (geometry 3/3, material 6/6, texture 3/3,
  mixer 3/3, listener 6/6, objectUrl 3/3, instance 3/3). A live instance keeps
  the shared resources alive after the resource is retired.
- **Reimport.** A newer load for the same `assetId` marks the pending load stale
  (`asset_load_stale`, completion discarded) and retires a settled resource
  without mixing versions.
- **Lost context.** The M1 adapter owns exactly two canvas listeners
  (`webglcontextlost`/`webglcontextrestored`), reports `render_context_lost`
  while lost (also from `captureScreenshot`), `preventDefault()`s the loss
  event, resumes its normal path after restore, and releases both listeners
  exactly once on dispose (double dispose releases nothing twice).
- **No network.** `fetch`/`XMLHttpRequest`/`WebSocket` stubbed to throw: prepare,
  instance, preview and `captureScreenshot` complete with no network access.

## Browser/WebGL — UNVERIFIED (no browser in this container)

1. pixels showing the mesh and its materials in a viewport (WebGL draw);
2. decode/upload of embedded PNG/JPEG textures (the Node path reports
   `asset_image_invalid` because there is no image decoder — a *browser*
   success is not claimed);
3. a real `webglcontextlost`/`webglcontextrestored` round trip and re-upload;
4. screenshot capture and the "not tainted" claim (`toDataURL` on a real canvas);
5. the real GLTFLoader + real browser `URL.createObjectURL` path for embedded
   images;
6. visual play/pause/scrub in the authoring viewport.

Exact packet-37 procedure (manual, real browser): serve the editor bundle
(`dist/editor`, `npm run build` output) and open the authoring page;
import/select a packet-24 GLB (`fixtures/m2/assets/tiny-v1.glb` and
`tiny-v2.glb`); confirm (a) the mesh renders with its two materials and correct
orientation, (b) the `Spin` clip plays, pauses and scrubs, (c) two placements of
the same asset move/animate independently, (d) `captureScreenshot` returns a
PNG whose pixels are readable and untinted, then force a context loss via
`WEBGL_lose_context.loseContext()` and confirm the structured
`render_context_lost` report plus a clean restore, and (e) repeated
load/reimport/dispose leaves no growth in the renderer's memory info
(`renderer.info.memory`). Record OS/browser/version, WebGL backend and
screenshots in the packet-37 manifest.

## Contract-change requests (recorded, not applied)

- **C26-1** `dependencies.md` §3 lists only the `three-adapter` `.` subpath; the
  real loader port is exposed on the new `./gltf-loader` subpath so the M1
  export/preview bundles stay loader-free (measured: their recorded §5.4.1
  counts are unchanged). Proposed diff: add the subpath row.
- **C26-2** `export.md` §5.4.1 binding 4 requires the export/preview bundles'
  `https://` count to be exactly 23, but `dependencies.md` §4.2/§7 intends the
  GLTFLoader subpath in those graphs (needed by packets 35/36). Measured today:
  adding the loader to the export graph gives `https://` 35 (Δ +12) — the scan
  would fail. Proposed diff: extend the version-bound exception table with a
  measured GLTFLoader row and restate binding 4 as core + loader row.
- **C26-3** the M2 extension allowlist is duplicated (a defensive empty copy)
  because `three-adapter → asset-pipeline` is a forbidden edge; the allowlist is
  injectable at the port, and a future allowlist change must be applied in both
  places (or the edge reconsidered).
- **C26-4** bounded limitation: the GLTFLoader-backed port clones instances with
  `Object3D.clone(true)`, which shares a `Skeleton` between instances; rigged
  skeletal animation is therefore not per-instance independent (no M2 fixture
  exercises skins; `asset-pipeline` counts no skins).
