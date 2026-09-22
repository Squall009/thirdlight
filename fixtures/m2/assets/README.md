# `fixtures/m2/assets/` — packet-24 bounded GLB import fixtures

**Self-generated, redistribution-safe.** Nothing here is downloaded: every byte
is produced from scratch by
[`tools/generate-fixtures.mjs`](tools/generate-fixtures.mjs) (raw buffers, a
hand-built GLB container, hand-built PNG chunks with real CRCs and a real zlib
`IDAT` stream for the 1x1 images).

```sh
node fixtures/m2/assets/tools/generate-fixtures.mjs   # rewrites *.glb + bytes.base64.json
node fixtures/m2/contracts/tools/check-fixtures.mjs   # the M2 contract checker (unaffected by this directory)
npm test -- packages/asset-pipeline                   # re-derives expected.json against the committed bytes
```

## Layout

```text
fixtures/m2/assets/
  tiny-v1.glb            valid: one triangle, two materials, one rotation clip
  tiny-v2.glb            the same whole model re-exported: changed geometry,
                         reordered materials/nodes, rewritten clip
  truncated.glb          header declares the full length, the bytes are cut short
  bad-chunk.glb          the second chunk is not BIN
  bad-json.glb           the JSON chunk repeats an object member name
  bom-json.glb           the JSON chunk starts with a byte-order mark
  accessor-overflow.glb  an accessor count overruns its bufferView
  external-uri-buffer.glb  the buffer is a remote URL
  external-uri-image.glb   the image is a `data:` URI
  required-extension.glb   `extensionsRequired: KHR_materials_unlit` (allowlist is empty)
  compression.glb          `KHR_draco_mesh_compression`
  decoded-limit.glb        header-declared 20000x20000 image (1.6 GB decoded pixels)
  image-count-limit.glb    65 one-pixel images
  count-limit.glb          4097 nodes
  malformed-clip.glb       animation input times are not strictly increasing
  empty-model.glb          a mesh with no primitives carries no geometry
  mime-mismatch.glb        PNG bytes declared as `image/jpeg`
  expected.json          the fixture index: digests, ordered diagnostics, metrics, recipe/metadata hashes
  bytes.base64.json      base64 sidecars of the committed `*.glb` files (generated)
  tools/generate-fixtures.mjs
```

## Conventions

- `expected.json` records, per file: the SHA-256 and byte length of the
  **committed** `.glb`, the `status`, the ordered §18.8.2 diagnostics
  (`codes`/`paths`/`limits`), the §18.6 `metrics` of an accepted model, and the
  §18.5 recipe digest plus the packet-24 metadata digest.
- `bytes.base64.json` carries the same bytes for the tests.
  `packages/asset-pipeline` is a pure leaf (`dependencies.md` §4.1: no Node
  built-ins, no I/O), so its tests cannot read files; they decode the sidecar and
  assert `sha256(bytes) === expected.json.sha256`, i.e. they run on the exact
  committed bytes.
- The `tiny-v1`/`tiny-v2` pair is the same whole-model asset at two versions: the
  internal glTF names and indices change, the whole-model identity and the
  `ImportRecipe` do not (project-model.md §18.1 rule 3, acceptance A02/A03).
- **Images are not decoded.** M2 has no image decoder, and the profile bounds
  `decodedImageBytes` from the PNG `IHDR` / JPEG frame header. `decoded-limit.glb`
  is header-valid with an `IDAT` payload that does not match its declared
  dimensions: it is exactly the adversarial input the decoded cap exists for. A
  full pixel decoder is out of scope for M2.
- Synthetic cases that cannot be committed (a >32 MiB source, a 2 000 001-vertex
  model) live in
  `packages/asset-pipeline/src/limits-and-jobs.test.ts`; chunk-framing mutations
  live in `packages/asset-pipeline/src/profile-rejections.test.ts`.
