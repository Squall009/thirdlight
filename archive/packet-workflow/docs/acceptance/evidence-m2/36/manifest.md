# Packet 36 evidence — standalone M2 content/gameplay export

- Packet: 36 (Standalone M2 content/gameplay export) · Gate I
- Date: 2026-09-19 · Tree: uncommitted (packets 20–36 in the working tree; no
  commit was made — the owner's instruction forbids commits/pushes)
- Environment: container, Node v22.22.1, no browser, no GPU, no physical input
  hardware. All numeric results below are from this container and are not
  reference-desktop or product-budget claims.

## 1. Toolchain (all commands actually run; raw tails in `toolchain.txt`)

| Command | Result |
|---|---|
| `npm test` | **135 files / 1701 tests passed** after the Gate I repair (packet-35 baseline: 129 files / 1672 tests; Gate I pre-repair: 133/1693) |
| `npm run typecheck` | exit 0 — 15 packages |
| `npm run check-deps` | exit 0 — all §7 pins exact |
| `npm run check-boundaries` | OK — 15 packages, 283 source files, 1068 specifiers, 0 violations |
| `npm run build` | 4 built, 0 skipped |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | OK — 34 check groups, 0 problems |

> **Gate I repair (2026-09-19).** The raw evidence under `artifacts/**` was
> regenerated from the repaired tree after **R-I-1** (`behavior-build` SHA-256
> `len ≡ 55 (mod 64)` padding) and **R-I-2** (`runtime.md` §14.5 effective input
> implemented in `@thirdlight/platformer`). The packet-36 integration suite now
> writes evidence **only** when `TL_EVIDENCE_DIR` is set (and the R-I-2
> `effective-input.json` only when `TL_R_I_2_EVIDENCE` is set), so an ordinary
> `npm test` can no longer clobber these committed bytes (**P2-3**). The export
> bundle grew from 4 455 999 B to **4 456 197 B** (+198 B) solely because the
> platformer controller now reads `ctx.intents`; the §5.4/§5.4.1 pattern counts
> are unchanged. The R-I-2 production-composition measurement lives in
> `docs/acceptance/evidence-m2/34/effective-input.json`.

Packet-36 suites: `packages/exporter/src/export-m2.test.ts` 9/9 (fake
service + fake compiler + in-memory fs, REAL esbuild build of the real M2
bootstrap over the real installed three/GLTFLoader/Rapier);
`tests/integration/m2-export/export-m2.test.ts` 7/7 (real backend child
process + real fs + real HTTP + real content/behavior publication + real
double export + independent static server + real Rapier trace);
`tests/integration/m2-export/sha256-cross-check.test.ts` 2/2.

## 2. Export closure (real export)

`artifacts/export-files.json` (measured byte sizes), `artifacts/manifest.json`,
`artifacts/meta.json` — a real M2 export of a v2 project
(`demo-store-01@r15`) with one reachable GLB, one source-bearing behavior, a
controller + collider course and a camera:

```text
index.html 626 · js/main.js 4 456 197 · manifest.json 3 399 · scene.json 823
content/sha256/5d9f7412… 1 552 · behaviors/55ff57e0….js 500 · meta.json 3 110
manifest.buildId aaedfa81… · meta.outputDigest c5e2097f…
```

Closure equality is asserted (the emitted file list equals the fixed layout
files plus exactly the manifest-declared artifact paths); the emitted
`scene.json` bytes re-hash to `manifest.sceneDigest`; the emitted GLB bytes are
byte-identical to the authoritative blob and pass the GLB container validator;
the emitted behavior bytes re-hash to the manifest `outputDigest`.

## 3. Format-aware scan (measured, `artifacts/scan.json`)

Export bundle 4 456 197 B, SHA-256 `9f377d63…`; §5.4 patterns
a/b/c/d/e/f/g/h/i/j = **0/0/0/7/0/3/0/38/0/5**; engine fetch call sites:
`./manifest.json` ×1, `./scene.json` ×1, one per declared asset path ×1
(behaviors are static bundle inputs, never fetched); `GLTFLoader` ×37; export
`scanHits` 0. Expected counts are computed as: core three (3 `fetch(`, 3
`process.`, 3 `http://` + 23 `https://`, 3 `XMLHttpRequest`) + the re-measured
Rapier compat probe (+1 `fetch(`) + 1 manifest + 1 scene + |asset paths| +
the exporter's own fixed page text (the mandatory trust notice contributes one
`XMLHttpRequest` and one `WebSocket`) + the GLTFLoader row (+12 `https://`).
The Rapier compat row and the page-text row are contract-change requests
(below); nothing was silently widened.

## 4. Reproducibility (`artifacts/double-export-diff.json`)

Two consecutive real exports of the same revision **landed in the same capture
second**: every file byte-identical, including `meta.json` (whose `exportedAt`
is the same second here), and `buildId`/`outputDigest` matched
(`rederivedBuildIdMatchesFirst: true`; `differingFiles: []`). When the capture
second changes, `capturedAt` — and the `buildId`/`outputDigest` derived from it
— changes as well (the committed earlier run in this repair straddled a second
and differed in `manifest.json`+`meta.json` only), and the exporter unit test
verifies full byte-identity with a fixed capture clock. The `capturedAt` in the
`buildId` preimage contradicts sessions.md §17.1.1's original "not a digest
input" note; **C36-7 was adjudicated accept-with-diff and the contract now
states the capture-second dependency** (sessions.md §17.1.1, export.md §7,
m2-acceptance A22).

## 5. Failure isolation (`artifacts/failure-injection.json`)

- Missing authoritative blob (`sources/sha256/<digest>` removed): export fails
  `export_scene_invalid`; the previous tree is **byte-untouched** (all 7 files
  re-hash equal).
- Corrupt blob (wrong bytes under the digest name): export fails
  `export_scene_invalid`; previous tree byte-untouched.
- Hostile behavior source (`fixtures/m2/behaviors/hostile/network.json`, an
  `https://` import): publication is refused upstream with
  `behavior_import_forbidden` / `reason: "network"` (real route, real
  compiler); the export output is untouched.
- Cold builds: three consecutive real exports, fresh esbuild build each time,
  337/335/343 ms, 0 failures (`artifacts/cold-builds.json`).

## 6. Negative credential/source probes

- No output byte contains the authoring/preview origin, the admin or authoring
  token, the backend host:port, `/api/v1/`, `node:` or a locator capability.
- A live play `contentId` (43-char capability) was created, then a re-export
  was performed: the capability appears in **no** byte of the new tree.
- The GLB validator rejects non-GLB magic, a wrong declared length, a remote
  `uri`, `data:`/`file:`/absolute/`..`/backslash URIs and duplicate JSON keys
  (unit tests); the WASM validator rejects wrong magic/version/pin.
- The M2 bundle graph check rejects `backend`, `workspace`, `commands`,
  `behavior-build`, another exporter file and `node:` builtins, and accepts the
  exact allowed set plus the two generated virtual modules.

## 7. Independent static server, non-root subpath

A plain static Node HTTP server served the tree under
`/games/<projectId>@r<revision>/` (non-root): `index.html` (text/html),
`js/main.js` (text/javascript), `manifest.json`/`scene.json`
(application/json), `content/sha256/<digest>` (**model/gltf-binary** —
extension-less path matched by path class), `behaviors/<digest>.js`
(text/javascript); a `.wasm` probe file returned `application/wasm`; a
traversal request outside the base path was rejected and no request outside
the base path was made. Deployment records: `docs/acceptance/deployment.md`
§7.2 (nginx non-root mapping, CSP, nosniff/no-referrer).

## 8. Play/export trace agreement (`artifacts/trace-diff.json`)

The same fixed step-indexed action sequence (120 executed steps: run right,
jump at steps 20–22) was run in Node with the **real Rapier adapter**
(`@dimforge/rapier2d-compat@0.20.0`) through the shared export composition
twice: once over the **play-locator artifact set** (fetched from the real
preview origin) and once over the **export tree**. Both manifests agreed on
`sceneDigest`, `contentDigest`, `assets`, `behaviors`, `modules`, `enginePins`
and `buildOptionsDigest`; the behavior and GLB bytes were byte-identical
between the two artifact sets (re-hashed). **Max |Δposition| over 120 steps =
0** (tolerance `1e-9`); both runs ended at x≈−1.1467, y≈0.9092. Because the
committed sample emits `control_move` every step, the effective input is the
behavior intent (`runtime.md` §14.5, R-I-2), so the fixed sampled `moveX` is
overridden — see `docs/acceptance/evidence-m2/34/effective-input.json` for the
production-composition speed measurement.

## 9. UNVERIFIED (no browser in this container)

Explicitly **UNVERIFIED**: the real-browser walkthrough — WebGL 2 rendering of
the exported scene/GLB, the trust-notice gate and start, `performance.now()`
frame loop, real WASM initialization under the CSP, keyboard/gamepad input,
tab resume, pixels/screenshots, and the browser network panel proving "no
external requests". No screenshot or walkthrough transcript is included
because none was produced.

Required procedure (packet 37, after Gate I):
1. Serve the tree produced by `POST /api/v1/admin/projects/<id>/export` from an
   independent static server under a non-root prefix with the §7.2 MIME rules
   (e.g. `http://127.0.0.1:8600/games/<projectId>@r<revision>/`).
2. **Stop the backend** (and the MCP/model services); confirm nothing on
   `:8501`/`:8502` answers and that the page still loads.
3. Open the page in a desktop browser; record OS/browser/version, URL, viewport,
   WebGL backend (`webgl2`), the HUD line (`snapshotId`, `buildId` prefix,
   render backend), console errors and the **network panel** (must show only
   `manifest.json`, `scene.json` and one read per declared asset — no external
   request, no `http(s)://` literal).
4. Accept the trust notice (the export declares one behavior), then play the
   course with the keyboard (A/D or arrows, Space) and with a physical
   controller (axis 0 / D-pad), and confirm the character traverses the floor
   and the model is rendered.
5. Record the CSP headers actually served and confirm WASM init succeeds (the
   Rapier module is inlined in the bundle today, so this is the CSP-script
   check).
6. Store the screenshots and the network/console export under
   `docs/acceptance/evidence-m2/37/`.

## 10. Contract-change requests (recorded, not applied)

- **C36-1** export.md §3's M2 layout has **no scene document**: `manifest.json`
  carries only `sceneDigest`, and the play path receives the scene over the
  bridge, so an exported page cannot instantiate the runtime. Implemented: the
  tree also emits `scene.json` (the exact `sceneDigest` preimage bytes) and the
  bootstrap reads it relative and digest-verifies it. Proposed diff: add
  `scene.json` to §3's layout and to the §17.5 export fetch row.
- **C36-2** dependencies.md §3 lists `captureManifest` on **both**
  `project-model` and `protocol`/`workspace` rows; protocol cannot be imported
  by project-model (leaf) and vice versa. Implemented: the pure derivation
  lives in `project-model` (`captureManifest` + `canonicalJsonText`/`sha256Hex`
  exports) and is re-exported through `exporter`; `protocol`'s duplicate
  constant/byte copies are cross-checked (byte equality) by tests. Proposed
  diff: name `project-model` the single owner and have protocol re-export.
- **C36-3** §6 does not define the `outputDigest` algorithm. Implemented (and
  documented): SHA-256 over the sorted emitted-closure listing
  (`path\ndigest\nbyteLength\n` per file, excluding `meta.json`). Proposed diff:
  write that definition into §6.
- **C36-4** §6 requires `behavior_trust_unacknowledged` to be read from
  `content.behaviorTrust.entries`, but **no public read exposes behaviorTrust**
  (C34-4). Implemented: the export relies on the unchanged publication-time
  trust gate (a source-bearing record cannot exist un-acknowledged) and records
  `behaviorTrust.acknowledgedSourceDigests` = the relied-on digests. Proposed
  diff: either expose the bounded trust read or state the structural
  enforcement in §6.
- **C36-5** §5.2/§4.2 say "`exporter/src/export-bootstrap.ts` (that file
  only)". The M2 bundle needs the M2 bootstrap, the shared composition module
  and the import-free page-text module (three exporter files). Implemented:
  `checkBundleGraphM2` allows exactly those three. Proposed diff: add the M2
  bundle row with its exact file list.
- **C36-6** §5.4.1's table has no row for (a) the pinned Rapier compat `fetch(`
  (C35-7), (b) the exporter's own mandatory §2.3 trust-notice text (which
  contains `XMLHttpRequest`/`WebSocket` by design), (c) the `./scene.json` read
  of C36-1, and (d) the fact that behaviors are **static** inputs, not a
  runtime fetch (§4.2 vs §17.5's export fetch list). Implemented: measured
  counts (Rapier probe re-measured per export; notice text counted from the
  fixed constant; scene read counted once) — never a blanket allowance.
  Proposed diff: add these rows.
- **C36-7** §17.1.1 says `capturedAt` is "not a digest input", but the promoted
  `MANIFEST_KEYS`/`manifestBuildIdInput` include it, so `buildId` (and the
  export `outputDigest`) change with the capture second. Implemented as
  promoted (packet 35 behaviour preserved) and recorded in §4 above. Proposed
  diff: exclude `capturedAt` from the preimage, or state that buildId is
  capture-second-dependent.

## 11. Bounded defect repair (P1, in scope as a dependency)

`packages/project-model/src/sha256.ts` computed the padded length as
`(((len + 9) >> 6) + 1) << 6`, allocating an extra zero block whenever
`(len + 9) % 64 === 0` (`len ≡ 55 mod 64`) and writing the length field into
it — so **every digest of such an input was wrong**. It affected this packet
directly (the export `sceneDigest` disagreed with the play path's digest).
Repaired to `ceil((len + 9) / 64)`; regression tests:
`packages/project-model/src/sha256-length.test.ts` (NIST vectors + known-answer
vectors for the defect class) and
`tests/integration/m2-export/sha256-cross-check.test.ts` (lengths 0…320 +
larger cases against `node:crypto`). No committed fixture digest changed
(`check-fixtures` 34/34 green).
