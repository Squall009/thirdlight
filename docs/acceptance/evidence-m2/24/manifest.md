# Packet 24 evidence — bounded GLB inspection and import proposals

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.** No git commit was made.

Raw outputs in `raw/` are literal command transcripts; nothing below is
reconstructed from memory.

## Scope

New pure leaf `packages/asset-pipeline` (`inspectGlb`/`prepareImport` over
supplied bytes and an injected job port) implementing project-model.md
§18.7/§18.8 in the §18.7.2 normative order, plus the §18.5 recipe digest and the
packet-24 metadata digest. Registration: `tools/check-boundaries.mjs` (UNITS +
one `NODE_SIDE_ALLOWED` row, project-model **types-only**) and the npm workspace
link. Self-generated fixtures under `fixtures/m2/assets/**`. No editor/server/
MCP/workspace code is reachable from this package and none was modified.

## Commands run and actual results

| Command | Result | Transcript |
|---|---|---|
| `npm test` | 77 files / **1077 passed** (exit 0) | `raw/npm-test.txt` |
| `npx vitest run packages/asset-pipeline --reporter=verbose` | 5 files / **102 passed**; per-test names + timings | `raw/asset-pipeline-verbose.txt` |
| `npm run typecheck` | exit 0, all 11 packages | `raw/npm-typecheck.txt` |
| `npm run check-deps` | `check-deps: OK`, all pins exact, no drift | `raw/npm-check-deps.txt` |
| `npm run check-boundaries` | `OK — 11 package(s), 183 source file(s), 660 specifier(s)`, no violations | `raw/npm-check-boundaries.txt` |
| `npm run build` | `build: done (4 built, 0 skipped)` exit 0 | `raw/npm-build.txt` |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | `check OK: 33 check group(s) passed, 0 problem(s)` | `raw/check-fixtures.txt` |
| `npm ls --depth=0` | no `ELSPROBLEMS`; the new workspace link resolves | `raw/independent-verification.txt` §4–5 |
| `sha256sum fixtures/m2/assets/*.glb` | 17 committed fixtures + lengths | `raw/fixture-hashes.txt` |
| per-fixture proposal dump (temporary test, removed) | status / ordered diagnostics / paths / limits / metrics / recipe+metadata digests | `raw/fixture-proposals.txt` |
| boundary negative probes (disposable, removed) | three violations, then one `types-only-edge` violation, then clean | `raw/boundary-negative-probe.txt` |
| `git status`/`git diff` scope capture | only the packet's files | `raw/scoped-diff.txt` |

Packet-24 suites and test counts (all passed):

| File | Tests |
|---|---|
| `packages/asset-pipeline/src/fixture-index.test.ts` | 23 |
| `packages/asset-pipeline/src/profile-rejections.test.ts` | 38 |
| `packages/asset-pipeline/src/limits-and-jobs.test.ts` | 12 |
| `packages/asset-pipeline/src/determinism.test.ts` | 7 |
| `packages/asset-pipeline/src/surface.test.ts` | 22 |
| **total** | **102** |

## Fixture set (self-generated, redistribution-safe)

17 committed GLBs, each produced from scratch by
`fixtures/m2/assets/tools/generate-fixtures.mjs` (raw buffers, hand-built GLB
container, hand-built PNG chunks with real CRCs and real zlib `IDAT` streams).
Nothing was downloaded. Per-file SHA-256 and byte length: `raw/fixture-hashes.txt`
and `fixtures/m2/assets/expected.json`.

- valid: `tiny-v1.glb` (one triangle, two materials, one rotation clip),
  `tiny-v2.glb` (the same whole model re-exported: changed geometry, reordered
  materials/nodes, rewritten clip);
- container/JSON: `truncated.glb`, `bad-chunk.glb`, `bad-json.glb`,
  `bom-json.glb`;
- arithmetic/URI/extension: `accessor-overflow.glb`,
  `external-uri-buffer.glb`, `external-uri-image.glb`,
  `required-extension.glb`, `compression.glb`, `mime-mismatch.glb`;
- decoded resources: `decoded-limit.glb` (header-declared 20000×20000 = 1.6 GB
  pixels), `image-count-limit.glb` (65 images), `count-limit.glb` (4097 nodes);
- clip/model: `malformed-clip.glb` (times not strictly increasing),
  `empty-model.glb` (mesh with no primitives).

The tests never read a file: `packages/asset-pipeline` is I/O-free
(dependencies.md §4.1), so they decode `bytes.base64.json` and assert
`sha256(bytes) === expected.json.sha256`. `raw/independent-verification.txt` §2
independently re-decoded all 17 sidecars with python3 (`base64` + `hashlib`) and
confirmed byte-identity with the committed `.glb` files and with the recorded
digests (17/17).

## §18.8.2 diagnostic vocabulary — where each code is exercised

Every code of the closed set is reached by a committed fixture or a synthetic
adversarial case (see `raw/fixture-proposals.txt` and the verbose test names):

`asset_size_exceeded` (empty + 33 554 433 B, synthetic), `asset_container_invalid`
(4 committed + 4 synthetic), `asset_json_invalid` (BOM, duplicate key committed;
UTF-8/root/trailing/8 MiB cap synthetic), `asset_version_unsupported` (glTF 1.0),
`asset_uri_rejected` (remote buffer + `data:` image), `asset_extension_unsupported`
(allowlist), `asset_compression_unsupported` (Draco), `asset_buffer_invalid`
(buffer count, length, padding, `target`, range, alignment),
`asset_accessor_invalid` (count/componentType/type/range/alignment/missing
bufferView), `asset_accessor_unsupported` (sparse, signed indices),
`asset_mesh_invalid` (missing mesh/POSITION/primitives), `asset_primitive_unsupported`
(mode, unknown attribute, primitive extensions), `asset_material_invalid`
(unknown field, `alphaMode`, factors, unresolved texture),
`asset_image_invalid` (no bufferView, mime, magic, unreadable header),
`asset_image_mime_mismatch`, `asset_texture_invalid` (source/sampler/wrap),
`asset_animation_invalid` (path, node, output type, times,
`KHR_animation_pointer`), `asset_node_invalid` (cycle, matrix+TRS, child, mesh),
`asset_scene_invalid` (missing scene, index, scene node), `asset_limits_exceeded`
(nodes, images, decoded bytes, vertices), `asset_empty_model`, `asset_timeout`
(timeout + cancellation).

## Determinism (acceptance A02 hashes)

- two runs of identical bytes + options are byte-identical (`JSON.stringify`
  equality) and the recipe/metadata digests agree — both in pure inspection mode
  and with a fresh job port carrying identical values;
- `raw/independent-verification.txt` §1 recomputed the recipe digest with
  python3 `hashlib` over the canonical recipe JSON
  (`{"extensions":[],"profile":"gltf-glb","recipeVersion":1,"toolchain":{"three":"0.186.0"}}`)
  → `dc1484512d50f8a83e321c7cc41dfbef56ddc0f89199987e90abcf5ef4e9df2e`, matching
  every entry of the index;
- `tiny-v1`/`tiny-v2` share the recipe digest and differ in source + metadata
  digest, and no proposal value carries the changed internal glTF names/indices
  (whole-model identity, §18.1 rule 3).

## No network, no plugin execution, immutability

- `surface.test.ts` stubs `fetch`/`XMLHttpRequest`/`WebSocket` with throwing
  stubs and inspects all 17 fixtures (including the remote/`data:` URI ones)
  → normal proposals, no access; the exported API surface is asserted
  exhaustively (no `register*`/loader/URL entries, no async functions).
- `Object.isFrozen` holds for the proposal and every nested value; mutation
  attempts throw in strict mode; the returned value contains no functions and no
  file handles/URLs.
- Static proof: `raw/boundary-negative-probe.txt` — a disposable probe importing
  `three`, `node:fs` and `@thirdlight/workspace` fails check 1 with three
  violations, and a disposable **value** import of `@thirdlight/project-model`
  fails with `types-only-edge`; both probes were removed and the check is clean
  again.

## Extension allowlist (contract §18.8.1)

`M2_GLTF_EXTENSION_ALLOWLIST` is frozen **empty**: no passing pinned-loader test
could be recorded (no browser/DOM in this container; this package may not import
`three` at all), so the contract's "effective allowlist is empty" branch applies
and every `extensionsUsed` member is rejected. Static grep evidence of the pinned
loader is recorded but explicitly is **not** the required passing test:
`raw/allowlist-decision.txt`.

## Contract-change requests (recorded, not applied)

The accepted contracts were not edited. Each item below was implemented in the
only way that satisfies the packet while keeping the accepted meaning, and each
needs a docs-only decision at review:

- **C24-1 — `prepareImport` is not in the dependencies.md §3 row.** Packet 24's
  instruction authorizes `inspectGlb`/`prepareImport` over bytes and injected job
  ports; §3's `asset-pipeline` row names only `inspectGlb(bytes, options)`.
  Proposed diff: extend the row to `.` → `inspectGlb(bytes, options)`,
  `prepareImport(bytes, options)` (the job-port-required entry),
  `importRecipeDigest(recipe)`, `importMetadataDigest(proposal)`,
  `ImportProposal`/`ImportDiagnostic`, `M2_GLTF_EXTENSION_ALLOWLIST`,
  `M2_GLTF_PROFILE_LIMITS`, `ImportJobPort`.
- **C24-2 — §18.7.2 step 7's literal `byteOffset <= 3` rejects every real GLB.**
  A bufferView at byteOffset 0/36/72/… (any glTF file, including the valid
  fixtures) would fail. Implemented the glTF 2.0 rule instead (accessor-backed
  bufferViews are 4-byte aligned; image-bearing bufferViews need no alignment).
  Proposed diff: replace that clause with "`bufferView.byteOffset` is a multiple
  of 4 when the bufferView is referenced by an accessor; image-bearing
  bufferViews are unaligned".
- **C24-3 — §18.9.3's `limits_exceeded` limit enum has no value for the
  JSON-chunk or per-image byte caps** that §18.7.2 steps 4/11 and the
  workspace.md §14 byte table report. Implemented `ImportLimitName` = the §18.9.3
  enum + `json_chunk_bytes` + `image_bytes`. Proposed diff: add both values to
  the §18.9.3 enum.
- **Note (docs inconsistency, no code judgement needed):** workspace.md's byte
  rows map byte caps to `import_rejected (limits_exceeded)` while the normative
  §18.7.2 steps 1/4 use `asset_size_exceeded` / `asset_json_invalid`. The
  normative §18.7.2 codes were implemented.

## Unverified / limitations

- No browser, WebGL, backend, HTTP or MCP path was exercised: packet 24 is the
  pure importer only, so acceptance rows A02/A04's **browser/UI** portions remain
  unverified here (packets 25–27). Evidence is unit-level over the real committed
  bytes.
- `inspectStage`/workspace wiring is **not** implemented (packet 24's edit scope
  is `packages/asset-pipeline/**` + fixtures + registration); the workspace still
  refuses `inspectStage` from packet 23 (C23-1 stays open, now unblocked).
- A cross-package integration test (`validateContent` over a version record built
  from a proposal) is not in this packet's edit scope; it is a packet-25 item.
- The decoded-geometry and triangle caps are unreachable within the 32 MiB source
  cap (the decoded layout cannot exceed the embedded bytes), so their only
  coverage is the cap-comparison logic and the synthetic vertex case; the
  reachable decoded cap is the header-derived image budget, which is covered by
  `decoded-limit.glb`.
- Images are bounded from header-declared dimensions, not decoded pixel data (M2
  has no image decoder); a header/dimension mismatch is therefore not detected
  beyond the decoded-bytes cap. Documented in `fixtures/m2/assets/README.md`.
- C24-2's implemented rule is deliberately strict: any bufferView referenced by
  an accessor must be 4-byte aligned (the glTF 2.0 rule is per-component-size).
  A hypothetical byte/short-component accessor packed at a 2-byte offset would be
  rejected by this profile. No committed fixture or packet-24 case does that, and
  no later packet's renderer path was exercised here; the proposed contract diff
  in C24-2 records the exact rule so review can relax or confirm it.
